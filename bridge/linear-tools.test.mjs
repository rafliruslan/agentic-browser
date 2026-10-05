import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS, callTool } from './linear-tools.mjs';

const ctx = (fetchFn) => ({ relayUrl: 'https://relay.example/', token: 'tok', agent: 'tara', fetchFn });

test('the toolset is exactly the allowlisted actions, each with a schema', () => {
  assert.deepEqual(TOOLS.map((t) => t.name), ['list_teams', 'list_users', 'search_issues', 'get_issue', 'create_issue', 'update_issue', 'add_comment']);
  for (const t of TOOLS) assert.equal(t.inputSchema.type, 'object');
  assert.ok(!TOOLS.some((t) => /delete|archive/i.test(t.name)));
});

test('a call goes to the relay as that agent, with the bearer, and returns the result as text', async () => {
  let seen;
  const out = await callTool('get_issue', { id: 'OPS-1' }, ctx(async (url, init) => {
    seen = { url, init };
    return { ok: true, json: async () => ({ ok: true, result: { id: 'OPS-1' } }) };
  }));
  assert.equal(seen.url, 'https://relay.example/linear/tara');
  assert.equal(seen.init.headers.authorization, 'Bearer tok');
  assert.deepEqual(JSON.parse(seen.init.body), { action: 'get_issue', args: { id: 'OPS-1' } });
  assert.equal(out.isError, undefined);
  assert.deepEqual(JSON.parse(out.content[0].text), { id: 'OPS-1' });
});

test('a refusal from the relay comes back as an error the agent can read, never the token', async () => {
  const out = await callTool('update_issue', { id: 'OPS-1' }, ctx(async () => ({ ok: false, status: 400, json: async () => ({ ok: false, error: 'Nothing to change' }) })));
  assert.equal(out.isError, true);
  assert.equal(out.content[0].text, 'Nothing to change');
  assert.doesNotMatch(JSON.stringify(out), /tok/);
});

test('a network failure gives a plain error with no URL', async () => {
  const out = await callTool('list_teams', {}, ctx(async () => { throw new Error('connect ECONNREFUSED https://relay.example/'); }));
  assert.equal(out.isError, true);
  assert.doesNotMatch(out.content[0].text, /relay\.example|ECONNREFUSED/);
});

test('an unknown tool never reaches the relay', async () => {
  let called = false;
  const out = await callTool('delete_issue', { id: 'OPS-1' }, ctx(async () => { called = true; }));
  assert.equal(called, false);
  assert.equal(out.isError, true);
});

test('a non-JSON reply falls back to the status line', async () => {
  const out = await callTool('list_teams', {}, ctx(async () => ({ ok: false, status: 502, json: async () => { throw new Error('html'); } })));
  assert.match(out.content[0].text, /502/);
});
