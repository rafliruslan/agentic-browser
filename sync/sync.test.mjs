import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { rig } from './test-helpers.mjs';
import { runPass, main } from './sync.mjs';
import { notifyCommand } from './notify.mjs';

test('one stopped store does not block the others, and status keeps last success', () => {
  const r = rig();
  const a = r.clone('a'); const b = r.clone('b');
  const s = r.state('b');
  const config = { machine: 'test', stores: [r.store(b, { name: 'one' }), r.store(b, { name: 'two' })] };
  let status = runPass({ config, state: s, notify: () => {} });
  assert.equal(status.stores.one.result, 'ok');
  const firstSuccess = status.stores.one.lastSuccess;
  s.stop('one', 'by hand');
  r.write(a, 'notes/z.md', 'z\n');
  runPass({ config: { machine: 'test', stores: [r.store(a)] }, state: r.state('a'), notify: () => {} });
  status = runPass({ config, state: s, notify: () => {} });
  assert.equal(status.stores.one.result, 'stopped');
  assert.equal(status.stores.one.lastSuccess, firstSuccess);
  assert.equal(status.stores.two.result, 'ok');
  assert.equal(r.read(b, 'notes/z.md'), 'z\n');
  assert.deepEqual(s.status(), status);
});

test('a second pass exits quietly while one is running', async () => {
  const r = rig();
  const a = r.clone('a');
  const s = r.state('a');
  const cfg = join(r.root, 'cfg.json');
  writeFileSync(cfg, JSON.stringify({ machine: 'test', stores: [r.store(a)] }));
  mkdirSync(s.dir, { recursive: true });
  // Held by a live process on this machine: the test runner's parent.
  writeFileSync(s.lockPath, JSON.stringify({ pid: process.ppid, host: hostname(), since: new Date().toISOString() }));
  assert.equal(await main([], { configPath: cfg, state: s, notify: () => {} }), 0);
  assert.deepEqual(s.status(), { stores: {} }, 'no pass ran');
});

test('--resume clears a stop and rejects unknown names', async () => {
  const r = rig();
  const a = r.clone('a');
  const s = r.state('a');
  const cfg = join(r.root, 'cfg.json');
  writeFileSync(cfg, JSON.stringify({ machine: 'test', stores: [r.store(a)] }));
  s.stop('mem', 'x');
  assert.equal(await main(['--resume', 'mem'], { configPath: cfg, state: s }), 0);
  assert.equal(s.stopped('mem'), null);
  assert.equal(await main(['--resume', 'nope'], { configPath: cfg, state: s }), 2);
});

test('notification command per platform', () => {
  assert.equal(notifyCommand('t', 'b', 'darwin')[0], 'osascript');
  assert.match(notifyCommand('t', 'say "hi"', 'darwin')[1][1], /display notification "say \\"hi\\"" with title "t"/);
  assert.deepEqual(notifyCommand('t', 'b', 'linux'), ['notify-send', ['t', 'b']]);
  assert.equal(notifyCommand('t', 'b', 'win32'), null);
});

test('a lock left by this machine under an older host name does not block passes', async () => {
  const r = rig();
  const a = r.clone('a');
  const s = r.state('a');
  const cfg = join(r.root, 'cfg.json');
  writeFileSync(cfg, JSON.stringify({ machine: 'test', stores: [r.store(a)] }));
  mkdirSync(s.dir, { recursive: true });
  writeFileSync(s.lockPath, JSON.stringify({ pid: 999_999, host: 'old-network-name', since: new Date().toISOString() }));
  assert.equal(await main([], { configPath: cfg, state: s, notify: () => {} }), 0);
  assert.equal(s.status().stores.mem.result, 'ok');
});

test('a lock under another host name held by a live pass is respected', async () => {
  const r = rig();
  const a = r.clone('a');
  const s = r.state('a');
  const cfg = join(r.root, 'cfg.json');
  writeFileSync(cfg, JSON.stringify({ machine: 'test', stores: [r.store(a)] }));
  mkdirSync(s.dir, { recursive: true });
  writeFileSync(s.lockPath, JSON.stringify({ pid: process.ppid, host: 'old-network-name', since: new Date().toISOString() }));
  assert.equal(await main([], { configPath: cfg, state: s, notify: () => {} }), 0);
  assert.deepEqual(s.status(), { stores: {} }, 'no pass ran');
});
