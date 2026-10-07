/**
 * Aside rewrites a note after each of its sessions, with no lock on the
 * markdown: it reads the note, works for up to a few minutes, then writes it.
 * If a sync merge changed the note in between, Aside's write is based on the
 * older version and silently undoes the merge.
 *
 * Aside's run log (.history.jsonl) records, per change, the SHA-256 of the note
 * it started from. The sync records every note it writes. A run that started
 * from the version the sync replaced, and finished after the sync wrote, lost
 * the sync's change; a three-way merge puts it back.
 */
import { createHash } from 'node:crypto';
import {
  openSync, readSync, fstatSync, closeSync, readFileSync, writeFileSync, renameSync, mkdtempSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { git } from './git.mjs';

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');
export const WRITE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Runs appended to the log since byte `offset`, read in chunks so a log of
 * hundreds of megabytes never sits in memory or in one string. With no offset
 * yet, it returns none and the current size: the past is already settled. Only
 * complete lines count. With `since`, runs that finished earlier are dropped,
 * and each kept run carries only the fields the check needs.
 */
export function readNewRuns(logPath, offset, { chunkSize = 8 * 1024 * 1024, since = -Infinity } = {}) {
  let fd;
  try { fd = openSync(logPath, 'r'); } catch { return { runs: [], offset: offset ?? 0 }; }
  try {
    const size = fstatSync(fd).size;
    if (offset === undefined || offset === null) return { runs: [], offset: size };
    let pos = offset > size ? 0 : offset; // a shorter log was replaced: start over
    let consumed = pos;
    let carry = Buffer.alloc(0);
    const runs = [];
    const keep = (line) => {
      if (!line.trim()) return;
      let run;
      try { run = JSON.parse(line); } catch { return; }
      if (since > -Infinity && !(Date.parse(run.finishedAt) >= since)) return;
      runs.push({
        id: run.id, startedAt: run.startedAt, finishedAt: run.finishedAt,
        changes: (run.changes ?? []).map((c) => ({ path: c.path, beforeSha256: c.beforeSha256, beforeContent: c.beforeContent })),
      });
    };
    while (pos < size) {
      const buf = Buffer.alloc(Math.min(chunkSize, size - pos));
      const n = readSync(fd, buf, 0, buf.length, pos);
      if (n <= 0) break;
      pos += n;
      const data = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
      let start = 0;
      for (let nl = data.indexOf(0x0a, start); nl >= 0; nl = data.indexOf(0x0a, start)) {
        keep(data.subarray(start, nl).toString('utf8'));
        consumed += nl - start + 1;
        start = nl + 1;
      }
      carry = Buffer.from(data.subarray(start));
    }
    return { runs, offset: consumed };
  } finally {
    closeSync(fd);
  }
}

export function findLostUpdates(runs, writes) {
  const lost = [];
  for (const run of runs) {
    const start = Date.parse(run.startedAt);
    const end = Date.parse(run.finishedAt);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    for (const c of run.changes ?? []) {
      if (!c.beforeSha256) continue;
      const w = writes.find((x) => x.path === c.path && x.preSha === c.beforeSha256
        && x.writtenAt >= start && x.writtenAt <= end);
      if (w) lost.push({ path: c.path, base: c.beforeContent ?? '', postBlob: w.postBlob });
    }
  }
  return lost;
}

export function mergeLostUpdate({ workTree, path, base, theirs }) {
  const file = join(workTree, path);
  const tmp = mkdtempSync(join(tmpdir(), 'agent-sync-'));
  try {
    const ours = join(tmp, 'aside');
    const before = join(tmp, 'before');
    const sync = join(tmp, 'sync');
    writeFileSync(ours, readFileSync(file));
    writeFileSync(before, base);
    writeFileSync(sync, theirs);
    const asideWrote = readFileSync(ours);
    const r = git(['merge-file', '-p', ours, before, sync], { cwd: tmp });
    if (r.code !== 0) return { clean: false };
    const out = join(dirname(file), `.${basename(file)}.agent-sync.tmp`);
    writeFileSync(out, r.stdout);
    renameSync(out, file);
    // What it replaced and what it wrote, so this write is checked like a merge's.
    return { clean: true, before: asideWrote, after: r.stdout };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Notes a merge from `from` to `to` changed, with their content before and the blob after. */
export function writesFromMerge(g, from, to, now) {
  const names = g(['diff', '--name-only', '--no-renames', '-z', from, to]).stdout.split('\0').filter(Boolean);
  const writes = [];
  for (const path of names) {
    const pre = g(['cat-file', 'blob', `${from}:${path}`], { encoding: 'buffer' });
    const post = g(['rev-parse', '--verify', '-q', `${to}:${path}`]);
    if (pre.code !== 0 || post.code !== 0) continue; // added or deleted: Aside cannot have started from it
    writes.push({ path, preSha: sha256(pre.stdout), postBlob: post.stdout.trim(), writtenAt: now });
  }
  return writes;
}

export const pruneWrites = (writes, now) => (writes ?? []).filter((w) => now - w.writtenAt < WRITE_TTL_MS);
