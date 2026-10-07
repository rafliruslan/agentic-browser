import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, expand } from './config.mjs';

const home = '/home/x';
const one = (store, extra = {}) => JSON.stringify({ machine: 'mac-a', stores: [store], ...extra });

test('expands ~ and fills defaults', () => {
  const c = loadConfig(one({ name: 'hammock', workTree: '~/m', remote: 'r' }), { home });
  assert.equal(c.machine, 'mac-a');
  assert.equal(c.intervalMinutes, 5);
  assert.deepEqual(c.stores[0], {
    name: 'hammock', workTree: '/home/x/m', gitDir: null, remote: 'r', branch: 'main',
    mode: 'readwrite', aside: false, relativeLinks: false,
  });
});

test('expands gitDir and keeps flags', () => {
  const c = loadConfig(one({ name: 'aside-u0', workTree: '~/a', gitDir: '~/g.git', remote: 'r', aside: true, mode: 'pull' }), { home });
  assert.equal(c.stores[0].gitDir, '/home/x/g.git');
  assert.equal(c.stores[0].aside, true);
  assert.equal(c.stores[0].mode, 'pull');
});

test('rejects bad input', () => {
  assert.throws(() => loadConfig(JSON.stringify({ stores: [] }), { home }), /non-empty/);
  assert.throws(() => loadConfig(one({ name: 'Bad Name', workTree: 'a', remote: 'r' }), { home }), /name/);
  assert.throws(() => loadConfig(one({ name: 'a', remote: 'r' }), { home }), /workTree/);
  assert.throws(() => loadConfig(one({ name: 'a', workTree: 'a' }), { home }), /remote/);
  assert.throws(() => loadConfig(one({ name: 'a', workTree: 'a', remote: 'r', mode: 'push' }), { home }), /mode/);
  const dup = JSON.stringify({ stores: [{ name: 'a', workTree: 'a', remote: 'r' }, { name: 'a', workTree: 'b', remote: 'r' }] });
  assert.throws(() => loadConfig(dup, { home }), /duplicate/);
  assert.throws(() => loadConfig(JSON.stringify({ intervalMinutes: 0, stores: [{ name: 'a', workTree: 'a', remote: 'r' }] }), { home }), /intervalMinutes/);
});

test('expand leaves other paths alone', () => {
  assert.equal(expand('~', home), '/home/x');
  assert.equal(expand('/abs', home), '/abs');
  assert.equal(expand('~other/x', home), '~other/x');
});
