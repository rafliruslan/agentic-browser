import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createState, stateDir } from './state.mjs';

const fresh = () => createState(join(mkdtempSync(join(tmpdir(), 'state-')), 'agent-sync'));

test('stateDir follows XDG_STATE_HOME', () => {
  assert.equal(stateDir({ XDG_STATE_HOME: '/s' }, '/h'), '/s/agent-sync');
  assert.equal(stateDir({}, '/h'), '/h/.local/state/agent-sync');
});

test('stop, stopped, resume', () => {
  const s = fresh();
  assert.equal(s.stopped('a'), null);
  s.stop('a', 'conflict in x.md');
  assert.equal(s.stopped('a'), 'conflict in x.md');
  assert.equal(s.stopped('b'), null);
  assert.equal(s.resume('a'), true);
  assert.equal(s.stopped('a'), null);
  assert.equal(s.resume('a'), false);
});

test('store state and status round-trip, with empty defaults', () => {
  const s = fresh();
  assert.deepEqual(s.store('a'), {});
  s.saveStore('a', { offset: 12, writes: [] });
  assert.deepEqual(s.store('a'), { offset: 12, writes: [] });
  assert.deepEqual(s.status(), { stores: {} });
  s.saveStatus({ stores: { a: { result: 'ok' } } });
  assert.equal(s.status().stores.a.result, 'ok');
  assert.ok(!existsSync(join(s.dir, 'status.json.tmp')));
});
