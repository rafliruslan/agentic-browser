import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRoles, parseList, requesterEnv, roleNote, gateUserFor, OPERATOR, TEAM, TEAM_DENIED_TOOLS } from './roles.mjs';

const OP = 'U_OP';

test('parseList trims, drops blanks and tolerates undefined', () => {
  assert.deepEqual(parseList(' U1, U2 ,,U3 '), ['U1', 'U2', 'U3']);
  assert.deepEqual(parseList(''), []);
  assert.deepEqual(parseList(undefined), []);
});

test('with no team configured only the operator is admitted', () => {
  const roles = createRoles({ operator: OP });
  assert.equal(roles.roleOf(OP, 'C1'), OPERATOR);
  assert.equal(roles.roleOf('U_X', 'C1'), null);
  assert.equal(roles.teamEnabled, false);
});

test('a teammate is admitted only in a listed channel', () => {
  const roles = createRoles({ operator: OP, teamUsers: 'U_A,U_B', teamChannels: 'C_OPS' });
  assert.equal(roles.roleOf('U_A', 'C_OPS'), TEAM);
  assert.equal(roles.roleOf('U_B', 'C_OPS'), TEAM);
  assert.equal(roles.roleOf('U_A', 'C_OTHER'), null);
  assert.equal(roles.roleOf('U_C', 'C_OPS'), null);
  assert.equal(roles.teamEnabled, true);
  assert.deepEqual(roles.counts, { users: 2, channels: 1 });
});

test('teammates with no channels listed are served nowhere (fail closed)', () => {
  const roles = createRoles({ operator: OP, teamUsers: 'U_A', teamChannels: '' });
  assert.equal(roles.roleOf('U_A', 'C_OPS'), null);
  assert.equal(roles.teamEnabled, false);
});

test('the operator stays the operator even if listed as a teammate', () => {
  const roles = createRoles({ operator: OP, teamUsers: `${OP},U_A`, teamChannels: 'C1' });
  assert.equal(roles.roleOf(OP, 'C9'), OPERATOR);
});

test('a missing sender has no role', () => {
  const roles = createRoles({ operator: OP, teamUsers: 'U_A', teamChannels: 'C1' });
  assert.equal(roles.roleOf(undefined, 'C1'), null);
  assert.equal(roles.roleOf('', 'C1'), null);
});

test('only a teammate turn carries the requester env for the hooks', () => {
  assert.deepEqual(requesterEnv(OPERATOR, OP), {});
  assert.deepEqual(requesterEnv(null, 'U_X'), {});
  assert.deepEqual(requesterEnv(TEAM, 'U_A'), { AGENT_REQUESTER_ROLE: 'team', AGENT_REQUESTER_ID: 'U_A' });
  assert.deepEqual(requesterEnv(TEAM, 'U_A', 'Ada L'), { AGENT_REQUESTER_ROLE: 'team', AGENT_REQUESTER_ID: 'U_A', AGENT_REQUESTER_NAME: 'Ada L' });
  assert.deepEqual(requesterEnv(OPERATOR, OP, 'Rafli'), {});
});

test('the teammate note names who is asking and the limits; the operator gets none', () => {
  assert.equal(roleNote(OPERATOR, OP), '');
  const note = roleNote(TEAM, 'U_A');
  assert.match(note, /teammate \(Slack user U_A\), not from Rafli/);
  assert.match(note, /credentials, Proton Pass items/);
  assert.match(note, /bank details/);
  assert.match(note, /DM him/);
  assert.match(note, /Linear tools \(mcp__linear\)/);
  assert.match(note, /Never use the browser for Linear/);
});

test('teammate turns refuse shell, scheduling and free-prompt tools', () => {
  for (const t of ['Bash', 'CronCreate', 'RemoteTrigger', 'mcp__aside__exec']) {
    assert.ok(TEAM_DENIED_TOOLS.includes(t), t);
  }
});

test('teammate turns may search and fetch the web', () => {
  for (const t of ['WebFetch', 'WebSearch']) {
    assert.ok(!TEAM_DENIED_TOOLS.includes(t), t);
  }
});

test('gateUserFor lets an admitted teammate through the single-user gates and nobody else', () => {
  const roles = createRoles({ operator: OP, teamUsers: 'U_A', teamChannels: 'C1' });
  assert.equal(gateUserFor(roles, { user: 'U_A', channel: 'C1' }, OP), 'U_A');
  assert.equal(gateUserFor(roles, { user: OP, channel: 'C1' }, OP), OP);
  // Not admitted: handed the operator's id, which they do not match.
  assert.equal(gateUserFor(roles, { user: 'U_A', channel: 'C_OTHER' }, OP), OP);
  assert.notEqual(gateUserFor(roles, { user: 'U_X', channel: 'C1' }, OP), 'U_X');
});
