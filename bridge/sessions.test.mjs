import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionStore } from './sessions.mjs';

async function store(opts = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'sessions-'));
  return createSessionStore({ path: join(dir, 'threads.json'), ...opts });
}

test('a thread with no session has no size', async () => {
  const s = await store();
  assert.equal(await s.tokens('t1'), 0);
  assert.equal(await s.noteTokens('t1', 5000), false);
});

test('the size is kept with the session and read back', async () => {
  const s = await store();
  await s.set('t1', 'id-a');
  assert.equal(await s.tokens('t1'), 0);
  assert.equal(await s.noteTokens('t1', 123_456), true);
  assert.equal(await s.tokens('t1'), 123_456);
});

test('setting the same session again keeps its size, a new one starts from nothing', async () => {
  const s = await store();
  await s.set('t1', 'id-a');
  await s.noteTokens('t1', 80_000);
  await s.set('t1', 'id-a');
  assert.equal(await s.tokens('t1'), 80_000);
  await s.set('t1', 'id-b');
  assert.equal(await s.tokens('t1'), 0);
});

test('forgetting a session clears its size and gives the thread a new id', async () => {
  const s = await store();
  await s.set('t1', 'id-a');
  await s.noteTokens('t1', 200_000);
  const before = await s.idFor('t1');
  await s.forget('t1');
  assert.equal(await s.get('t1'), null);
  assert.equal(await s.tokens('t1'), 0);
  assert.notEqual(await s.idFor('t1'), before);
});

test('noteTokens ignores a size that is not a positive number', async () => {
  const s = await store();
  await s.set('t1', 'id-a');
  await s.noteTokens('t1', 50_000);
  assert.equal(await s.noteTokens('t1', null), false);
  assert.equal(await s.noteTokens('t1', 0), false);
  assert.equal(await s.noteTokens('t1', NaN), false);
  assert.equal(await s.tokens('t1'), 50_000);
});

test('noting a size is not activity, so it does not keep an old session alive', async () => {
  let t = 1_000;
  const s = await store({ now: () => t, maxAgeMs: 10_000 });
  await s.set('t1', 'id-a');
  t = 8_000;
  await s.noteTokens('t1', 9_000);
  t = 12_000;
  assert.equal(await s.get('t1'), null);
});

test('the size survives a restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sessions-'));
  const path = join(dir, 'threads.json');
  const a = createSessionStore({ path });
  await a.set('t1', 'id-a');
  await a.noteTokens('t1', 77_000);
  const b = createSessionStore({ path });
  assert.equal(await b.tokens('t1'), 77_000);
});
