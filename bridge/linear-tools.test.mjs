import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS, callTool } from './linear-tools.mjs';

const ctx = (fetchFn) => ({ relayUrl: 'https://relay.example/', token: 'tok', agent: 'tara', fetchFn });

test('the toolset is exactly the allowlisted actions, each with a schema', () => {
  assert.deepEqual(TOOLS.map((t) => t.name).sort(), ['add_comment', 'archive_issue', 'create_issue', 'get_issue', 'list_cycles', 'list_labels', 'list_projects', 'list_teams', 'list_users', 'search_issues', 'set_cycle', 'set_labels', 'set_project', 'unarchive_issue', 'update_issue']);
  for (const t of TOOLS) assert.equal(t.inputSchema.type, 'object');
  assert.ok(!TOOLS.some((t) => /delete|destroy|remove/i.test(t.name)));
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

test('the requester goes to the relay from the context, and cannot come from the arguments', async () => {
  let sent;
  await callTool('add_comment', { id: 'OPS-1', body: 'x', requester: 'someone-else' }, { ...ctx(async (u, init) => { sent = JSON.parse(init.body); return { ok: true, json: async () => ({ ok: true, result: {} }) }; }), requester: 'real-id' });
  assert.equal(sent.requester, 'real-id');
  assert.equal(sent.args.requester, 'someone-else');
  let none;
  await callTool('list_teams', {}, ctx(async (u, init) => { none = JSON.parse(init.body); return { ok: true, json: async () => ({ ok: true, result: [] }) }; }));
  assert.equal('requester' in none, false);
});
