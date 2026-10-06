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

// A Slack teammate is not a Linear user, so the relay cannot credit them. The
// name comes from the bridge's environment, and the tools write it themselves.
const slackCtx = (calls, extra = {}) => ({
  ...ctx(async (u, init) => { calls.push(JSON.parse(init.body)); return { ok: true, json: async () => ({ ok: true, result: { done: true } }) }; }),
  requester: 'U09ABC',
  requesterName: 'Ada L',
  ...extra,
});

test('a new ticket for a Slack teammate carries their name in its description', async () => {
  const calls = [];
  await callTool('create_issue', { team: 'OPS', title: 'T', description: 'Body' }, slackCtx(calls));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.description, 'Body\n\nRequested by Ada L (Slack).');
  const bare = [];
  await callTool('create_issue', { team: 'OPS', title: 'T' }, slackCtx(bare));
  assert.equal(bare[0].args.description, 'Requested by Ada L (Slack).');
});

test('a comment for a Slack teammate carries their name', async () => {
  const calls = [];
  await callTool('add_comment', { id: 'OPS-1', body: 'hello' }, slackCtx(calls));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.body, 'hello\n\nRequested by Ada L (Slack).');
});

test('any other change is noted on the issue first, so an archive can still be commented on', async () => {
  const calls = [];
  await callTool('archive_issue', { id: 'OPS-1' }, slackCtx(calls));
  assert.deepEqual(calls.map((c) => c.action), ['add_comment', 'archive_issue']);
  assert.match(calls[0].args.body, /^Ada L asked via Slack: archive_issue/);
  const upd = [];
  await callTool('update_issue', { id: 'OPS-2', status: 'Done' }, slackCtx(upd));
  assert.match(upd[0].args.body, /update_issue \{"status":"Done"\}/);
  assert.deepEqual(upd[1].args, { id: 'OPS-2', status: 'Done' });
});

test('reads are never noted, and a Linear user id is left to the relay', async () => {
  const reads = [];
  await callTool('get_issue', { id: 'OPS-1' }, slackCtx(reads));
  assert.deepEqual(reads.map((c) => c.action), ['get_issue']);
  const uuid = [];
  await callTool('create_issue', { team: 'OPS', title: 'T' }, slackCtx(uuid, { requester: '123e4567-e89b-12d3-a456-426614174000' }));
  assert.equal(uuid[0].args.description, undefined);
  const none = [];
  await callTool('create_issue', { team: 'OPS', title: 'T' }, slackCtx(none, { requesterName: undefined }));
  assert.equal(none[0].args.description, undefined);
});

test('a name is cleaned before it reaches a ticket', async () => {
  const calls = [];
  await callTool('create_issue', { team: 'OPS', title: 'T' }, slackCtx(calls, { requesterName: 'Eve\n**[x](http://evil)** <b>' }));
  assert.equal(calls[0].args.description, 'Requested by Eve xhttp://evil b (Slack).');
});
