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

export function readNewRuns(logPath, offset) {
  let fd;
  try { fd = openSync(logPath, 'r'); } catch { return { runs: [], offset: 0 }; }
  try {
    const size = fstatSync(fd).size;
    if (offset === undefined || offset === null) return { runs: [], offset: size };
    let from = offset > size ? 0 : offset;
    if (from === size) return { runs: [], offset: size };
    const buf = Buffer.alloc(size - from);
    readSync(fd, buf, 0, buf.length, from);
    const end = buf.lastIndexOf(0x0a);
    if (end < 0) return { runs: [], offset: from };
    const runs = [];
    for (const line of buf.subarray(0, end).toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      try { runs.push(JSON.parse(line)); } catch { /* a line Aside never finished; skip it */ }
    }
    return { runs, offset: from + end + 1 };
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
    const r = git(['merge-file', '-p', ours, before, sync], { cwd: tmp });
    if (r.code !== 0) return { clean: false };
    const out = join(dirname(file), `.${basename(file)}.agent-sync.tmp`);
    writeFileSync(out, r.stdout);
    renameSync(out, file);
    return { clean: true };
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
