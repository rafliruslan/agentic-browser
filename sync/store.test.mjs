import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { rig } from './test-helpers.mjs';
import { syncStore } from './store.mjs';
import { sha256 } from './aside-guard.mjs';

const ctx = (state, extra = {}) => ({ state, machine: 'test', ...extra });

test('a change on one machine reaches the other', () => {
  const r = rig();
  const a = r.clone('a'); const b = r.clone('b');
  r.write(a, 'notes/new note é.md', 'hello\n');
  assert.equal(syncStore(r.store(a), ctx(r.state('a'))).status, 'ok');
  assert.equal(syncStore(r.store(b), ctx(r.state('b'))).status, 'ok');
  assert.equal(r.read(b, 'notes/new note é.md'), 'hello\n');
  assert.match(r.sh(a, 'log', '-1', '--format=%an <%ae> %s'), /^agent-sync <agent-sync@test> sync from test/);
});

test('episodic lines added on both machines are both kept', () => {
  const r = rig();
  const a = r.clone('a'); const b = r.clone('b');
  appendFileSync(join(a, 'episodic/2026-10-07.md'), 'from a\n');
  appendFileSync(join(b, 'episodic/2026-10-07.md'), 'from b\n');
  syncStore(r.store(a), ctx(r.state('a')));
  assert.equal(syncStore(r.store(b), ctx(r.state('b'))).status, 'ok');
  syncStore(r.store(a), ctx(r.state('a')));
  for (const dir of [a, b]) {
    const text = r.read(dir, 'episodic/2026-10-07.md');
    assert.ok(text.includes('from a') && text.includes('from b'), dir);
  }
});

test('the same line edited on both machines stops only that store, work tree intact', () => {
  const r = rig();
  const a = r.clone('a'); const b = r.clone('b');
  r.write(a, 'notes/a.md', 'one\nTWO-A\nthree\n');
  r.write(b, 'notes/a.md', 'one\nTWO-B\nthree\n');
  syncStore(r.store(a), ctx(r.state('a')));
  const notes = [];
  const sb = r.state('b');
  const res = syncStore(r.store(b), ctx(sb, { notify: (t, m) => notes.push(m) }));
  assert.equal(res.status, 'stopped');
  assert.match(res.detail, /notes\/a\.md/);
  assert.equal(r.read(b, 'notes/a.md'), 'one\nTWO-B\nthree\n');
  assert.ok(!existsSync(join(b, '.git', 'MERGE_HEAD')));
  assert.equal(notes.length, 1);
  assert.equal(syncStore(r.store(b), ctx(sb, { notify: (t, m) => notes.push(m) })).status, 'stopped');
  assert.equal(notes.length, 1, 'notified once, not every pass');
});

test('a token stops the store before anything is committed', () => {
  const r = rig();
  const a = r.clone('a');
  const token = `xoxb-${'1'.repeat(30)}`;
  r.write(a, 'notes/slack.md', `bot: ${token}\n`);
  const before = r.sh(a, 'rev-parse', 'HEAD');
  const res = syncStore(r.store(a), ctx(r.state('a')));
  assert.equal(res.status, 'stopped');
  assert.match(res.detail, /notes\/slack\.md \(slack-token\)/);
  assert.ok(!res.detail.includes(token));
  assert.equal(r.sh(a, 'rev-parse', 'HEAD'), before);
  assert.equal(r.sh(a, 'diff', '--cached', '--name-only'), '');
});

test('a rejected push merges and retries once in the same pass', () => {
  const r = rig();
  const a = r.clone('a'); const b = r.clone('b');
  r.write(a, 'notes/from-a.md', 'a\n');
  r.write(b, 'notes/from-b.md', 'b\n');
  let raced = false;
  const res = syncStore(r.store(a), ctx(r.state('a'), {
    beforePush: () => { if (!raced) { raced = true; syncStore(r.store(b), ctx(r.state('b'))); } },
  }));
  assert.equal(res.status, 'ok');
  const c = r.clone('c');
  assert.ok(existsSync(join(c, 'notes/from-a.md')) && existsSync(join(c, 'notes/from-b.md')));
});

test('offline keeps local commits and pushes them on the next good pass', () => {
  const r = rig();
  const a = r.clone('a');
  r.write(a, 'notes/x.md', 'x\n');
  r.sh(a, 'remote', 'set-url', 'origin', join(r.root, 'missing.git'));
  const res = syncStore(r.store(a), ctx(r.state('a')));
  assert.equal(res.status, 'offline');
  assert.equal(r.state('a').stopped('mem'), null);
  r.sh(a, 'remote', 'set-url', 'origin', r.remote);
  assert.equal(syncStore(r.store(a), ctx(r.state('a'))).status, 'ok');
  assert.ok(existsSync(join(r.clone('c'), 'notes/x.md')));
});

test('pull mode never commits or pushes', () => {
  const r = rig();
  const a = r.clone('a'); const p = r.clone('p');
  r.write(p, 'notes/local-only.md', 'mine\n');
  r.write(a, 'notes/remote.md', 'theirs\n');
  syncStore(r.store(a), ctx(r.state('a')));
  assert.equal(syncStore(r.store(p, { mode: 'pull' }), ctx(r.state('p'))).status, 'ok');
  assert.equal(r.read(p, 'notes/remote.md'), 'theirs\n');
  assert.ok(!existsSync(join(r.clone('c'), 'notes/local-only.md')));
});

test('a stopped store is skipped until resumed', () => {
  const r = rig();
  const a = r.clone('a');
  const s = r.state('a');
  s.stop('mem', 'by hand');
  r.write(a, 'notes/y.md', 'y\n');
  assert.equal(syncStore(r.store(a), ctx(s)).status, 'stopped');
  assert.equal(r.sh(a, 'status', '--porcelain').trim(), '?? notes/y.md');
  s.resume('mem');
  assert.equal(syncStore(r.store(a), ctx(s)).status, 'ok');
});

test('Aside overwriting a note mid-sync is repaired, keeping both changes', () => {
  const base = 'a\nb\nc\nd\ne\n';
  const r = rig({ seed: { 'n.md': base } });
  const a = r.clone('a'); const b = r.clone('b');
  writeFileSync(join(a, '.git', 'info', 'exclude'), '.history.jsonl\n');
  const log = join(a, '.history.jsonl');
  writeFileSync(log, '');
  const sa = r.state('a');
  let t = Date.parse('2026-10-07T10:00:00Z');
  const now = () => t;
  const asideStore = r.store(a, { aside: true });

  syncStore(asideStore, ctx(sa, { now })); // first sight: offset at end of log
  r.write(b, 'n.md', 'A\nb\nc\nd\ne\n');
  syncStore(r.store(b), ctx(r.state('b')));

  t += 60_000;
  const writtenAt = t;
  syncStore(asideStore, ctx(sa, { now })); // merge writes b's change into Aside's folder
  assert.equal(r.read(a, 'n.md'), 'A\nb\nc\nd\ne\n');

  // Aside read the note before that write and saves after it.
  r.write(a, 'n.md', 'a\nb\nc\nd\nE\n');
  appendFileSync(log, `${JSON.stringify({
    startedAt: new Date(writtenAt - 30_000).toISOString(),
    finishedAt: new Date(writtenAt + 30_000).toISOString(),
    changes: [{ path: 'n.md', beforeSha256: sha256(base), beforeContent: base }],
  })}\n`);

  t += 120_000;
  assert.equal(syncStore(asideStore, ctx(sa, { now })).status, 'ok');
  assert.equal(r.read(a, 'n.md'), 'A\nb\nc\nd\nE\n');
  assert.equal(r.read(r.clone('c'), 'n.md'), 'A\nb\nc\nd\nE\n');
});

test('an Aside run based on the synced version changes nothing', () => {
  const r = rig({ seed: { 'n.md': 'a\n' } });
  const a = r.clone('a');
  writeFileSync(join(a, '.git', 'info', 'exclude'), '.history.jsonl\n');
  const log = join(a, '.history.jsonl');
  writeFileSync(log, '');
  const sa = r.state('a');
  const asideStore = r.store(a, { aside: true });
  syncStore(asideStore, ctx(sa));
  r.write(a, 'n.md', 'a\nb\n');
  appendFileSync(log, `${JSON.stringify({
    startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    changes: [{ path: 'n.md', beforeSha256: sha256('a\n'), beforeContent: 'a\n' }],
  })}\n`);
  assert.equal(syncStore(asideStore, ctx(sa)).status, 'ok');
  assert.equal(r.read(a, 'n.md'), 'a\nb\n');
});

test('a token in a commit made outside the sync is never pushed', () => {
  const r = rig();
  const a = r.clone('a');
  r.write(a, 'notes/hand.md', `key ${'ghp_' + 'a'.repeat(36)}\n`);
  r.sh(a, 'add', '-A');
  r.sh(a, 'commit', '-q', '-m', 'an agent committed this itself');
  r.write(a, 'notes/hand.md', 'cleaned\n');
  r.sh(a, 'commit', '-q', '-am', 'and removed it later');
  const res = syncStore(r.store(a), ctx(r.state('a')));
  assert.equal(res.status, 'stopped');
  assert.match(res.detail, /notes\/hand\.md \(github-token\)/);
  assert.ok(!existsSync(join(r.clone('c'), 'notes/hand.md')), 'nothing pushed');
});

test('a token inside a file git calls binary is still caught', () => {
  const r = rig();
  const a = r.clone('a');
  r.write(a, 'notes/blob.dat', `\u0000\u0001 xoxb-${'1'.repeat(30)} \u0000`);
  const res = syncStore(r.store(a), ctx(r.state('a')));
  assert.equal(res.status, 'stopped');
  assert.match(res.detail, /notes\/blob\.dat \(slack-token\)/);
});

test('a token added while resolving a merge by hand is never pushed', () => {
  const r = rig();
  const a = r.clone('a'); const b = r.clone('b');
  r.write(b, 'notes/a.md', 'one\nTWO-B\nthree\n');
  syncStore(r.store(b), ctx(r.state('b')));
  r.write(a, 'notes/a.md', 'one\nTWO-A\nthree\n');
  r.sh(a, 'commit', '-q', '-am', 'local edit');
  r.sh(a, 'fetch', '-q');
  try { r.sh(a, 'merge', '-q', 'origin/main'); } catch { /* conflict expected */ }
  r.write(a, 'notes/a.md', `one\nTWO ${'glpat-' + 'a'.repeat(20)}\nthree\n`);
  r.sh(a, 'add', '-A');
  r.sh(a, 'commit', '-q', '--no-edit');
  const res = syncStore(r.store(a), ctx(r.state('a')));
  assert.equal(res.status, 'stopped');
  assert.match(res.detail, /gitlab-token/);
  assert.ok(!r.read(r.clone('c'), 'notes/a.md').includes('glpat-'));
});
