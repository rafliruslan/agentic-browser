/**
 * Unpack a zip into a folder, with no shell and no library.
 *
 * The agent that cannot run a command cannot run `unzip`, and a zip from Slack is
 * how artwork, exports and bundles arrive. Unpacking it here, inside the Slack
 * tool server, gives her the files without giving her Bash.
 *
 * The archive is untrusted, and extraction is where a hostile one does harm, so
 * this does the minimum and refuses the rest:
 *
 * - A name is only ever a path *under* the folder. An absolute path, a drive
 *   letter, a `..`, a NUL or a backslash trick is skipped, and the final path is
 *   checked to sit inside the folder again before anything is written.
 * - A symlink entry is skipped, never created. A folder is made only by this code,
 *   so nothing in the archive can point a later write somewhere else.
 * - Files are written new (`wx`), mode 0600, so none is executable and a duplicate
 *   name, or one that differs only in case, cannot overwrite an earlier file.
 * - Three ceilings bound what a hostile file may ask for: entries, bytes per entry,
 *   and bytes in total. They are enforced on what actually inflates, not on the
 *   sizes the archive claims.
 * - Nothing is run, opened or followed. A nested archive is written as it is.
 *
 * `sandbox` is the stricter profile for an agent that reads untrusted mail and
 * chat: lower ceilings, and no program, script, installer or hidden file is
 * written at all.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { BudgetError, OfficeError, openZip } from './office-text.mjs';

const MB = 1024 * 1024;

/** What one unpack may do. The sandbox is the default; a deployment opts out of it. */
export const LIMITS = {
  full: { maxEntries: 2000, maxEntryBytes: 64 * MB, maxTotalBytes: 256 * MB, maxDepth: 12 },
  sandbox: { maxEntries: 500, maxEntryBytes: 32 * MB, maxTotalBytes: 96 * MB, maxDepth: 8 },
};

/** A path segment longer than this is not a real file name. */
const MAX_SEGMENT = 200;

/** What a Mac adds to every archive it makes. Never wanted, never reported as a loss. */
const isMacJunk = (segments) => segments[0] === '__MACOSX' || segments.at(-1) === '.DS_Store' || segments.at(-1).startsWith('._');

/** Programs, scripts, installers and shortcuts. Skipped by name in the sandbox. */
const RISKY_NAME =
  /\.(exe|dll|bat|cmd|com|scr|msi|msp|cpl|hta|lnk|reg|ps1|psm1|vbs|vbe|jse|wsf|jar|sh|bash|zsh|command|term|terminal|scpt|workflow|pkg|dmg|iso|apk|ipa|dylib|so|js|mjs|cjs|py|rb|pl|php|webloc|url)$/i;

/** A folder that macOS treats as one program or plug-in. */
const RISKY_FOLDER = /\.(app|framework|bundle|xpc|kext|plugin|prefpane|saver)$/i;

/** Whether the bytes start like a program: PE, ELF, Mach-O (thin and fat), or a #! script. */
export function looksExecutable(data) {
  if (data.length < 4) return false;
  if (data[0] === 0x4d && data[1] === 0x5a) return true; // MZ
  if (data[0] === 0x23 && data[1] === 0x21) return true; // #!
  const m = data.readUInt32BE(0);
  return m === 0x7f454c46 || m === 0xfeedface || m === 0xfeedfacf || m === 0xcefaedfe || m === 0xcffaedfe || m === 0xcafebabe;
}

/**
 * The segments of an entry name under the folder, or the reason it is unsafe.
 *
 * @returns {{ segments: string[] } | { reason: string }}
 */
export function entrySegments(name) {
  const raw = String(name);
  if (raw.includes('\0')) return { reason: 'unsafe path (NUL)' };
  const path = raw.replace(/\\/g, '/');
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return { reason: 'unsafe path (absolute)' };
  const segments = path.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.some((s) => s === '..')) return { reason: 'unsafe path (climbs out)' };
  if (!segments.length) return { reason: 'empty name' };
  if (segments.some((s) => s.length > MAX_SEGMENT)) return { reason: 'name too long' };
  // Control characters are never part of a real name and break every tool that lists one.
  return { segments: segments.map((s) => s.replace(/[\x00-\x1f\x7f]/g, '_')) };
}

/**
 * Unpack `buf` into `dest`, which must already exist, be empty, and be ours.
 *
 * @param {Buffer} buf
 * @param {string} dest
 * @param {{ sandbox?: boolean }} [opts]
 * @returns {Promise<{ error: string } | { files: {path:string,size:number}[], skipped: {name:string,reason:string}[], bytes: number, stopped: string|null }>}
 */
export async function unpackZip(buf, dest, { sandbox = true } = {}) {
  const lim = sandbox ? LIMITS.sandbox : LIMITS.full;
  const zip = openZip(buf, { totalBudget: lim.maxTotalBytes, maxEntryBytes: lim.maxEntryBytes, maxEntries: lim.maxEntries });
  if (zip.error) return { error: zip.error };

  const files = [];
  const skipped = [];
  let bytes = 0;
  let stopped = null;
  const skip = (name, reason) => skipped.push({ name, reason });

  for (const [name, read] of zip.entries) {
    const info = zip.meta.get(name);
    const parsed = entrySegments(name);
    if (parsed.reason) {
      skip(name, parsed.reason);
      continue;
    }
    const { segments } = parsed;
    if (isMacJunk(segments)) {
      skip(name, 'macOS metadata');
      continue;
    }
    if (info.symlink) {
      skip(name, 'symlink');
      continue;
    }
    if (segments.length > lim.maxDepth) {
      skip(name, 'nested too deep');
      continue;
    }
    if (sandbox && segments.some((s) => s.startsWith('.'))) {
      skip(name, 'hidden file (sandbox)');
      continue;
    }
    if (sandbox && (segments.slice(0, -1).some((s) => RISKY_FOLDER.test(s)) || (!info.dir && RISKY_NAME.test(segments.at(-1))))) {
      skip(name, 'program or script (sandbox)');
      continue;
    }

    const target = join(dest, ...segments);
    if (!target.startsWith(dest + sep)) {
      skip(name, 'unsafe path (outside the folder)');
      continue;
    }

    try {
      if (info.dir) {
        await mkdir(target, { recursive: true, mode: 0o700 });
        continue;
      }
      const data = read();
      if (sandbox && looksExecutable(data)) {
        skip(name, 'program or script (sandbox)');
        continue;
      }
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, data, { flag: 'wx', mode: 0o600 });
      files.push({ path: segments.join('/'), size: data.length });
      bytes += data.length;
    } catch (err) {
      if (err instanceof BudgetError) {
        // Every later entry would be refused too: say so once and stop.
        stopped = `the archive inflates past ${lim.maxTotalBytes} bytes; the rest was not unpacked`;
        break;
      }
      if (err instanceof OfficeError) skip(name, err.message.replace(/^Refused: /, '').replace(/\.$/, ''));
      else if (err?.code === 'EEXIST' || err?.code === 'ENOTDIR' || err?.code === 'EISDIR') skip(name, 'name clashes with an earlier entry');
      else if (err?.code === 'Z_DATA_ERROR' || err?.code === 'Z_BUF_ERROR') skip(name, 'damaged data');
      else skip(name, `could not write (${err?.code || 'error'})`);
    }
  }
  return { files, skipped, bytes, stopped };
}

const human = (n) => (n >= MB ? `${(n / MB).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);

/** The result as lines for the agent: what was unpacked, and what was left out and why. */
export function describeUnpack(result, dest, { listMax = 60 } = {}) {
  if (result.error) return [`Could not unpack it: ${result.error}`];
  const { files, skipped, bytes, stopped } = result;
  const lines = [`Unpacked ${files.length} file${files.length === 1 ? '' : 's'} (${human(bytes)}) into ${dest}`];
  for (const f of files.slice(0, listMax)) lines.push(`  ${f.path} (${human(f.size)})`);
  if (files.length > listMax) lines.push(`  ... and ${files.length - listMax} more`);

  // Mac metadata is in every archive from a Mac: count it, do not list it.
  const byReason = new Map();
  for (const s of skipped) byReason.set(s.reason, [...(byReason.get(s.reason) || []), s.name]);
  for (const [reason, names] of byReason) {
    const shown = reason === 'macOS metadata' ? '' : `: ${names.slice(0, 5).join(', ')}${names.length > 5 ? ', ...' : ''}`;
    lines.push(`Left out, ${reason} (${names.length})${shown}`);
  }
  if (stopped) lines.push(`Stopped early: ${stopped}.`);
  lines.push('Nothing in the archive was run. Read the files with Read; a zip inside it was written as it is, not opened.');
  return lines;
}
