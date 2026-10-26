import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { verdict, watchSocket, STALE_MS, GRACE_MS } from './socket-watch.mjs';

const quiet = { log() {}, error() {} };

test('connected is always fine', () => {
  assert.equal(verdict({ up: true, since: 0, now: 10 * STALE_MS }), 'ok');
});

test('a short drop is left to the client to fix', () => {
  assert.equal(verdict({ up: false, since: 0, now: STALE_MS - 1 }), 'ok');
});

test('down past the limit with nothing running exits', () => {
  assert.equal(verdict({ up: false, since: 0, now: STALE_MS }), 'exit');
});

test('a run in flight gets the grace period, then no more', () => {
  assert.equal(verdict({ up: false, since: 0, now: STALE_MS, busy: true }), 'wait');
  assert.equal(verdict({ up: false, since: 0, now: STALE_MS + GRACE_MS - 1, busy: true }), 'wait');
  assert.equal(verdict({ up: false, since: 0, now: STALE_MS + GRACE_MS, busy: true }), 'exit');
});

function harness({ busy = () => false } = {}) {
  let t = 1_000_000;
  const client = new EventEmitter();
  const exits = [];
  const lines = [];
  const log = { log: (s) => lines.push(s), error: (s) => lines.push(s) };
  const w = watchSocket({
    client, busy, intervalMs: 5, staleMs: 100, graceMs: 100,
    now: () => t, log, exit: (code) => exits.push(code),
  });
  return { client, exits, lines, w, advance: (ms) => { t += ms; }, tick: () => new Promise((r) => setTimeout(r, 20)) };
}

test('a drop that recovers never exits, and both ends are logged', async () => {
  const h = harness();
  h.client.emit('reconnecting');
  h.advance(50);
  h.client.emit('connecting');
  h.advance(30);
  h.client.emit('connected');
  h.advance(1000);
  await h.tick();
  clearInterval(h.w.timer);
  assert.deepEqual(h.exits, []);
  assert.equal(h.lines.length, 2, 'one line down, one line back');
  assert.match(h.lines[1], /reconnected after 0s down/);
});

test('the down clock starts at the first drop, not the latest event', async () => {
  const h = harness();
  h.client.emit('disconnected');
  h.advance(80);
  h.client.emit('reconnecting');
  h.advance(30);
  await h.tick();
  clearInterval(h.w.timer);
  assert.deepEqual(h.exits, [0], '110ms down in total passes the 100ms limit');
});

test('a stalled reconnect exits exactly once, with 0', async () => {
  const h = harness();
  h.client.emit('reconnecting');
  h.advance(150);
  await h.tick();
  await h.tick();
  clearInterval(h.w.timer);
  assert.deepEqual(h.exits, [0]);
  assert.match(h.lines.at(-1), /not coming back; exiting/);
});

test('it waits for a run in flight, and says so once', async () => {
  let running = true;
  const h = harness({ busy: () => running });
  h.client.emit('reconnecting');
  h.advance(150);
  await h.tick();
  assert.deepEqual(h.exits, []);
  assert.equal(h.lines.filter((s) => /run is in flight/.test(s)).length, 1);
  running = false;
  await h.tick();
  clearInterval(h.w.timer);
  assert.deepEqual(h.exits, [0]);
});

test('the timer never keeps a finished process alive', () => {
  const w = watchSocket({ client: new EventEmitter(), log: quiet, exit() {} });
  assert.equal(w.timer.hasRef(), false);
  clearInterval(w.timer);
});

test('a recovery reports when the drop began, so a catch-up can start there', async () => {
  let t = 5_000;
  const client = new EventEmitter();
  const got = [];
  const w = watchSocket({ client, intervalMs: 1e6, now: () => t, log: quiet, exit() {}, onReconnect: (since) => got.push(since) });
  client.emit('connected');
  client.emit('reconnecting');
  t += 700;
  client.emit('connecting');
  t += 300;
  client.emit('connected');
  clearInterval(w.timer);
  assert.deepEqual(got, [5_000], 'once, for the real recovery, from the first drop');
});
