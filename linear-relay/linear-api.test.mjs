import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAction, ActionError, ACTIONS } from './src/linear-api.mjs';

const U = '11111111-2222-3333-4444-555555555555';

/** A fake Linear: answers by the first word of the query, and records every call. */
function fake(handlers) {
  const calls = [];
  const gql = async (query, variables) => {
    calls.push({ query, variables });
    for (const [needle, reply] of Object.entries(handlers)) {
      if (query.includes(needle)) return typeof reply === 'function' ? reply(variables) : reply;
    }
    throw new Error(`unexpected query ${query.slice(0, 40)}`);
  };
  return { gql, calls };
}

const issue = { id: 'uuid-1', identifier: 'OPS-9', url: 'u', team: { key: 'OPS', states: { nodes: [{ id: 's1', name: 'Todo' }, { id: 's2', name: 'In Review' }] } } };

test('only the listed actions exist, and nothing destructive is on the list', () => {
  assert.deepEqual(ACTIONS, ['list_teams', 'list_users', 'search_issues', 'get_issue', 'create_issue', 'update_issue', 'add_comment']);
  assert.ok(!ACTIONS.some((a) => /delete|archive|remove|project|cycle|label/.test(a)));
});

test('an unknown action is refused with the list of known ones', async () => {
  const { gql } = fake({});
  await assert.rejects(runAction('issueDelete', {}, gql), (e) => e instanceof ActionError && /Known: list_teams/.test(e.message));
});

test('list_users returns ids and names only, no emails', async () => {
  const { gql } = fake({ users: { users: { nodes: [{ id: U, name: 'A', displayName: 'a', email: 'a@x.com' }] } } });
  const out = await runAction('list_users', {}, gql);
  assert.deepEqual(out, [{ id: U, name: 'A', displayName: 'a' }]);
});

test('search_issues clamps the limit and passes the query as a variable', async () => {
  const { gql, calls } = fake({ issues: { issues: { nodes: [{ identifier: 'OPS-1', title: 't', url: 'u', state: { name: 'Todo' }, assignee: null, team: { key: 'OPS' } }] } } });
  const out = await runAction('search_issues', { query: 'invoice', limit: 500 }, gql);
  assert.equal(calls[0].variables.n, 20);
  assert.equal(calls[0].variables.q, 'invoice');
  assert.deepEqual(out[0], { id: 'OPS-1', title: 't', url: 'u', status: 'Todo', assignee: null, team: 'OPS' });
  await assert.rejects(runAction('search_issues', {}, gql), /query is required/);
});

test('get_issue validates the id and trims long text', async () => {
  const { gql } = fake({ 'issue(id:$id)': { issue: { identifier: 'OPS-9', title: 't', description: 'x'.repeat(5000), url: 'u', priority: 2, state: { name: 'Todo' }, assignee: { name: 'R' }, team: { key: 'OPS' }, labels: { nodes: [{ name: 'bug' }] }, comments: { nodes: [{ body: 'c', createdAt: 'now', user: { name: 'Z' } }] } } } });
  const out = await runAction('get_issue', { id: 'OPS-9' }, gql);
  assert.equal(out.description.length, 4003);
  assert.deepEqual(out.labels, ['bug']);
  assert.equal(out.comments[0].by, 'Z');
  await assert.rejects(runAction('get_issue', { id: 'not an id; drop' }, gql), /look like OPS-123/);
  await assert.rejects(runAction('get_issue', {}, gql), /id is required/);
});

test('create_issue resolves the team key, then creates, and validates every field', async () => {
  const { gql, calls } = fake({
    'teams(filter': { teams: { nodes: [{ id: 'team-1', key: 'OPS' }] } },
    issueCreate: { issueCreate: { success: true, issue: { identifier: 'OPS-10', title: 'T', url: 'u' } } },
  });
  const out = await runAction('create_issue', { team: 'ops', title: 'T', description: 'd', priority: 3, assignee: U }, gql);
  assert.deepEqual(out, { identifier: 'OPS-10', title: 'T', url: 'u' });
  assert.equal(calls[0].variables.k, 'OPS');
  assert.deepEqual(calls[1].variables.input, { teamId: 'team-1', title: 'T', description: 'd', priority: 3, assigneeId: U });
  await assert.rejects(runAction('create_issue', { team: 'OPS', title: 'T', priority: 9 }, gql), /priority must be/);
  await assert.rejects(runAction('create_issue', { team: 'OPS', title: 'T', assignee: 'bob' }, gql), /assignee must be a user id/);
  await assert.rejects(runAction('create_issue', { team: 'a b', title: 'T' }, gql), /team key/);
  await assert.rejects(runAction('create_issue', { team: 'OPS', title: 'x'.repeat(301) }, gql), /too long/);
});

test('update_issue maps a status name to its id and refuses an unknown one with the options', async () => {
  const { gql, calls } = fake({
    'issue(id:$id){ id identifier': { issue: issue },
    issueUpdate: { issueUpdate: { success: true, issue: { identifier: 'OPS-9', title: 'T', url: 'u', state: { name: 'In Review' }, assignee: null, priority: 2 } } },
  });
  const out = await runAction('update_issue', { id: 'OPS-9', status: 'in review', priority: 2 }, gql);
  assert.equal(out.status, 'In Review');
  assert.deepEqual(calls[1].variables.input, { priority: 2, stateId: 's2' });
  assert.equal(calls[1].variables.id, 'uuid-1');
  await assert.rejects(runAction('update_issue', { id: 'OPS-9', status: 'Shipped' }, gql), /Options: Todo, In Review/);
  await assert.rejects(runAction('update_issue', { id: 'OPS-9' }, gql), /Nothing to change/);
});

test('update_issue can clear the assignee with "none" and nothing else sneaks in', async () => {
  const { gql, calls } = fake({
    'issue(id:$id){ id identifier': { issue: issue },
    issueUpdate: { issueUpdate: { success: true, issue: { identifier: 'OPS-9', title: 'T', url: 'u', state: null, assignee: null, priority: 0 } } },
  });
  await runAction('update_issue', { id: 'OPS-9', assignee: 'none', archivedAt: 'now', teamId: 'other' }, gql);
  assert.deepEqual(calls[1].variables.input, { assigneeId: null });
});

test('add_comment resolves the issue and posts the body', async () => {
  const { gql, calls } = fake({
    'issue(id:$id){ id identifier': { issue: issue },
    commentCreate: { commentCreate: { success: true, comment: { id: 'c1', url: 'cu' } } },
  });
  const out = await runAction('add_comment', { id: 'OPS-9', body: 'hello' }, gql);
  assert.deepEqual(out, { posted: true, issue: 'OPS-9', url: 'cu' });
  assert.deepEqual(calls[1].variables.input, { issueId: 'uuid-1', body: 'hello' });
  await assert.rejects(runAction('add_comment', { id: 'OPS-9', body: '' }, gql), /body is required/);
});

test('a failed mutation is an error, not a silent success', async () => {
  const { gql } = fake({ 'issue(id:$id){ id identifier': { issue: issue }, commentCreate: { commentCreate: { success: false } } });
  await assert.rejects(runAction('add_comment', { id: 'OPS-9', body: 'x' }, gql), /did not post/);
});
