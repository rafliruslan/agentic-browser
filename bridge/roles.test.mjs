import { test } from 'node:test';
import assert from 'node:assert/strict';
import { channelKind, createRoles, parseList, requesterEnv, roleNote, gateUserFor, opsPrivate, OPERATOR, TEAM, TEAM_DENIED_TOOLS } from './roles.mjs';

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

test('* admits teammates in any channel, except !ID ones and DMs', () => {
  const roles = createRoles({ operator: OP, teamUsers: 'U_A', teamChannels: '*,!C_PRIVATE' });
  assert.equal(roles.roleOf('U_A', 'C_NEW', 'channel'), TEAM);
  assert.equal(roles.roleOf('U_A', 'G_OLD', 'group'), TEAM);
  assert.equal(roles.roleOf('U_A', 'C_PRIVATE', 'channel'), null);
  assert.equal(roles.roleOf('U_A', 'D_DM', 'im'), null);
  assert.equal(roles.roleOf('U_X', 'C_NEW', 'channel'), null);
  assert.equal(roles.roleOf(OP, 'C_PRIVATE'), OPERATOR);
  assert.equal(roles.teamEnabled, true);
});

// A group DM's id starts with C or G, like a channel's, so only its kind tells.
test('* never admits a teammate in a group DM, or where the kind is unknown', () => {
  const roles = createRoles({ operator: OP, teamUsers: 'U_A', teamChannels: '*,C_LISTED' });
  assert.equal(roles.roleOf('U_A', 'C_MPDM', 'mpim'), null);
  assert.equal(roles.roleOf('U_A', 'G_MPDM', 'mpim'), null);
  assert.equal(roles.roleOf('U_A', 'C_NEW'), null, 'an app_mention whose lookup failed');
  assert.equal(roles.roleOf('U_A', '', 'channel'), null);
  assert.equal(roles.roleOf('U_A', undefined, 'channel'), null);
  assert.equal(roles.roleOf('U_A', 'C_LISTED'), TEAM, 'a channel listed by id needs no kind');
  assert.equal(roles.needsKind('U_A', 'C_NEW'), true);
  assert.equal(roles.needsKind('U_A', 'C_LISTED'), false);
  assert.equal(roles.needsKind('U_X', 'C_NEW'), false, 'no lookup for someone who is not a teammate');
  assert.equal(roles.needsKind(OP, 'C_NEW'), false);
  assert.equal(createRoles({ operator: OP, teamUsers: 'U_A', teamChannels: 'C1' }).needsKind('U_A', 'C2'), false);
});

test('channelKind reads conversations.info', () => {
  assert.equal(channelKind({ is_channel: true }), 'channel');
  assert.equal(channelKind({ is_channel: true, is_private: true }), 'group');
  assert.equal(channelKind({ is_group: true }), 'group');
  assert.equal(channelKind({ is_mpim: true, is_private: true, is_group: true }), 'mpim');
  assert.equal(channelKind({ is_im: true }), 'im');
  assert.equal(channelKind({}), null);
  assert.equal(channelKind(undefined), null);
});

test('only !ID entries admit nobody (fail closed)', () => {
  const roles = createRoles({ operator: OP, teamUsers: 'U_A', teamChannels: '!C1' });
  assert.equal(roles.roleOf('U_A', 'C2'), null);
  assert.equal(roles.teamEnabled, false);
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
  assert.match(note, /Shopify order.*delivery details.*Nothing else about the customer/);
  assert.match(note, /DM him/);
  assert.match(note, /Anything sexual in nature.*needs Rafli's yes first/);
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

test('ops is a subset of the team: only a listed teammate is ops, and only then is it passed on', () => {
  const r = createRoles({ operator: 'UOP', teamUsers: 'U1,U2', teamChannels: '*', opsUsers: 'U1,U9,UOP' });
  assert.equal(r.isOps('U1'), true);
  assert.equal(r.isOps('U2'), false);
  // Not a teammate, so not ops either, and the operator is never ops.
  assert.equal(r.isOps('U9'), false);
  assert.equal(r.isOps('UOP'), false);
  assert.equal(requesterEnv(TEAM, 'U1', 'A', { ops: true }).AGENT_REQUESTER_OPS, '1');
  assert.equal(requesterEnv(TEAM, 'U2', 'B').AGENT_REQUESTER_OPS, undefined);
  assert.deepEqual(requesterEnv(OPERATOR, 'UOP', '', { ops: true }), {});
});

test('opsPrivate: only the requester\'s own DM, or a private channel of ops alone, all pages checked', async () => {
  const info = { D1: { is_im: true, user: 'U1' }, D2: { is_im: true, user: 'U2' }, G1: { is_private: true }, G2: { is_private: true }, G3: { is_private: true }, C1: { is_channel: true }, M1: { is_mpim: true } };
  // G1 also holds an app (B-prefixed here), which does not count as a person.
  const pages = { G1: [['U1', 'UBOT', 'BLINEAR'], ['UOP']], G2: [['U1'], ['U2']], G3: 'endless' };
  const client = { users: { info: async ({ user }) => ({ user: { id: user, is_bot: user.startsWith('B') } }) }, conversations: {
    info: async ({ channel }) => { if (!info[channel]) throw new Error('channel_not_found'); return { channel: info[channel] }; },
    members: async ({ channel, cursor }) => {
      if (pages[channel] === 'endless') return { members: ['U1'], response_metadata: { next_cursor: 'more' } };
      const i = cursor ? Number(cursor) : 0;
      const list = pages[channel];
      return { members: list[i], response_metadata: { next_cursor: i + 1 < list.length ? String(i + 1) : '' } };
    },
  } };
  const opts = { members: new Set(['U1', 'UOP', 'UBOT']), requester: 'U1' };
  assert.equal(await opsPrivate(client, 'D1', opts), true);
  assert.equal(await opsPrivate(client, 'G1', opts), true);
  for (const ch of ['D2', 'G2', 'G3', 'C1', 'M1', 'nope']) assert.equal(await opsPrivate(client, ch, opts), false, ch);
  assert.equal(await opsPrivate(client, 'D1', { ...opts, requester: '' }), false);
});
