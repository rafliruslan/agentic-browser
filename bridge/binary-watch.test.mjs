import test from 'node:test';
import assert from 'node:assert/strict';
import { binaryGone, watchOwnBinary } from './binary-watch.mjs';

test('a binary that exists is not gone', () => {
  assert.equal(binaryGone('/opt/homebrew/Cellar/node/26.10.0_2/bin/node', () => true), false);
});

test('a binary that has been deleted is gone', () => {
  // What brew upgrade does to the node a long-running bridge started on.
  assert.equal(binaryGone('/opt/homebrew/Cellar/node/26.10.0_1/bin/node', () => false), true);
});

test('no exec path is never treated as gone', () => {
  assert.equal(binaryGone('', () => false), false);
  assert.equal(binaryGone(undefined, () => false), false);
});

test('the watcher exits once the binary disappears, and only once', async () => {
  let present = true;
  const exits = [];
  const t = watchOwnBinary({
    execPath: '/x/node', intervalMs: 5, exists: () => present,
    log: { error() {} }, exit: (code) => exits.push(code),
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(exits, [], 'no exit while the binary is there');
  present = false;
  await new Promise((r) => setTimeout(r, 30));
  clearInterval(t);
  assert.deepEqual(exits, [0], 'exits exactly once, with 0, so launchd restarts it');
});

test('the timer never keeps a finished process alive', () => {
  const t = watchOwnBinary({ execPath: '/x/node', exists: () => true, exit() {} });
  assert.equal(t.hasRef(), false);
  clearInterval(t);
});
