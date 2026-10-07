import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync, readFileSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readNewRuns, findLostUpdates, mergeLostUpdate, pruneWrites, sha256, WRITE_TTL_MS } from './aside-guard.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'guard-'));
const run = (o) => `${JSON.stringify(o)}\n`;

test('first sight starts from the end of the log', () => {
  const log = join(tmp(), '.history.jsonl');
  writeFileSync(log, run({ id: 'old' }));
  const r = readNewRuns(log, undefined);
  assert.deepEqual(r.runs, []);
  assert.equal(r.offset, readFileSync(log).length);
});

test('reads only complete new lines, and resets when the log shrinks', () => {
  const log = join(tmp(), '.history.jsonl');
  writeFileSync(log, run({ id: 'a' }));
  let r = readNewRuns(log, 0);
  assert.deepEqual(r.runs.map((x) => x.id), ['a']);
  appendFileSync(log, `${run({ id: 'b' })}{"id":"half`);
  r = readNewRuns(log, r.offset);
  assert.deepEqual(r.runs.map((x) => x.id), ['b']);
  appendFileSync(log, '"}\n');
  r = readNewRuns(log, r.offset);
  assert.deepEqual(r.runs.map((x) => x.id), ['half']);
  truncateSync(log, 0);
  writeFileSync(log, run({ id: 'c' }));
  r = readNewRuns(log, 10_000);
  assert.deepEqual(r.runs.map((x) => x.id), ['c']);
});



const T = Date.parse('2026-10-07T10:00:00Z');
const write = { path: 'n.md', preSha: sha256('old\n'), postBlob: 'abc', writtenAt: T };
const aRun = (change, start = T - 1000, end = T + 1000) => ({
  startedAt: new Date(start).toISOString(), finishedAt: new Date(end).toISOString(), changes: [change],
});

test('a run that read before the sync wrote and saved after is a lost update', () => {
  const lost = findLostUpdates([aRun({ path: 'n.md', beforeSha256: sha256('old\n'), beforeContent: 'old\n' })], [write]);
  assert.deepEqual(lost, [{ path: 'n.md', base: 'old\n', postBlob: 'abc' }]);
});

test('runs based on the synced version, outside the window, or creating a note are not', () => {
  const based = aRun({ path: 'n.md', beforeSha256: sha256('new\n'), beforeContent: 'new\n' });
  const before = aRun({ path: 'n.md', beforeSha256: sha256('old\n'), beforeContent: 'old\n' }, T - 5000, T - 2000);
  const created = aRun({ path: 'n.md', beforeSha256: null, beforeContent: null });
  const other = aRun({ path: 'm.md', beforeSha256: sha256('old\n'), beforeContent: 'old\n' });
  assert.deepEqual(findLostUpdates([based, before, created, other], [write]), []);
});

test('three-way merge keeps both sides, or reports a conflict', () => {
  const dir = tmp();
  const base = 'a\nb\nc\nd\ne\n';
  writeFileSync(join(dir, 'n.md'), 'a\nb\nc\nd\nE\n'); // Aside's write
  const merged = mergeLostUpdate({ workTree: dir, path: 'n.md', base, theirs: 'A\nb\nc\nd\ne\n' });
  assert.equal(merged.clean, true);
  assert.equal(merged.before.toString(), 'a\nb\nc\nd\nE\n');
  assert.equal(merged.after, 'A\nb\nc\nd\nE\n');
  assert.equal(readFileSync(join(dir, 'n.md'), 'utf8'), 'A\nb\nc\nd\nE\n');

  writeFileSync(join(dir, 'n.md'), 'a\nb\nX\nd\ne\n');
  assert.deepEqual(mergeLostUpdate({ workTree: dir, path: 'n.md', base, theirs: 'a\nb\nY\nd\ne\n' }), { clean: false });
  assert.equal(readFileSync(join(dir, 'n.md'), 'utf8'), 'a\nb\nX\nd\ne\n', 'Aside file untouched on conflict');
});

test('old writes are pruned', () => {
  const now = T + WRITE_TTL_MS + 1;
  assert.deepEqual(pruneWrites([write, { ...write, writtenAt: now - 10 }], now).length, 1);
  assert.deepEqual(pruneWrites(undefined, now), []);
});

test('a missing log keeps the offset, and reads go in chunks across line breaks', () => {
  assert.deepEqual(readNewRuns(join(tmp(), 'none.jsonl'), 77), { runs: [], offset: 77 });
  const log = join(tmp(), '.history.jsonl');
  writeFileSync(log, ['a', 'b', 'c'].map((id) => run({ id, startedAt: 's', finishedAt: '2026-10-07T10:00:00Z', changes: [] })).join(''));
  const r = readNewRuns(log, 0, { chunkSize: 7 });
  assert.deepEqual(r.runs.map((x) => x.id), ['a', 'b', 'c']);
  assert.equal(r.offset, readFileSync(log).length);
});

test('runs finished before the oldest write are not kept', () => {
  const log = join(tmp(), '.history.jsonl');
  writeFileSync(log, run({ id: 'old', finishedAt: '2026-10-01T00:00:00Z' }) + run({ id: 'new', finishedAt: '2026-10-07T10:00:00Z' }));
  const r = readNewRuns(log, 0, { since: Date.parse('2026-10-07T00:00:00Z') });
  assert.deepEqual(r.runs.map((x) => x.id), ['new']);
});
