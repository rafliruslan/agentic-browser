import test from 'node:test';
import assert from 'node:assert/strict';
import { isMention, answered, createSeen, findMissed, createCatchup, lateNote } from './catchup.mjs';

const BOT = 'UBOT';
const quiet = { log() {}, warn() {}, error() {} };
const ts = (sec) => `${sec}.000100`;

test('a mention is a person tagging the bot in a plain message or file share', () => {
  assert.equal(isMention({ user: 'U1', text: `<@${BOT}> hi` }, BOT), true);
  assert.equal(isMention({ user: 'U1', subtype: 'file_share', text: `<@${BOT}> see` }, BOT), true);
  assert.equal(isMention({ user: 'U1', text: 'hi' }, BOT), false);
  assert.equal(isMention({ user: BOT, text: `<@${BOT}>` }, BOT), false);
  assert.equal(isMention({ user: 'U1', bot_id: 'B1', text: `<@${BOT}>` }, BOT), false);
  assert.equal(isMention({ user: 'U1', subtype: 'message_changed', text: `<@${BOT}>` }, BOT), false);
});

test('answered means a reaction from the bot, or a bot reply after it', () => {
  const m = { ts: ts(100), user: 'U1' };
  assert.equal(answered({ ...m, reactions: [{ name: 'eyes', users: [BOT] }] }, [], BOT), true);
  assert.equal(answered({ ...m, reactions: [{ name: 'eyes', users: ['U2'] }] }, [], BOT), false);
  assert.equal(answered(m, [{ ts: ts(101), user: BOT }], BOT), true);
  assert.equal(answered(m, [{ ts: ts(99), user: BOT }], BOT), false, 'an earlier reply is not an answer');
});

test('seen claims once and forgets the oldest past its cap', () => {
  const s = createSeen(2);
  assert.equal(s.claim('C', '1'), true);
  assert.equal(s.claim('C', '1'), false);
  s.claim('C', '2');
  s.claim('C', '3');
  assert.equal(s.has('C', '1'), false);
  assert.equal(s.has('C', '3'), true);
});

function fakeClient({ channels, history, replies, fail = new Set() }) {
  const calls = [];
  return {
    calls,
    users: { conversations: async (a) => { calls.push(['users', a]); return { channels }; } },
    conversations: {
      history: async (a) => {
        calls.push(['history', a]);
        if (fail.has(a.channel)) throw Object.assign(new Error('x'), { data: { error: 'not_in_channel' } });
        return { messages: history[a.channel] || [] };
      },
      replies: async (a) => { calls.push(['replies', a]); return { messages: replies[`${a.channel}/${a.ts}`] || [] }; },
    },
  };
}

test('findMissed finds an unanswered mention in an old thread and skips answered ones', async () => {
  const since = 1000 * 1000;
  const until = 1600 * 1000;
  const client = fakeClient({
    channels: [{ id: 'C1' }, { id: 'C2' }],
    history: {
      C1: [
        // An old parent whose thread got a mention inside the window.
        { ts: ts(10), user: 'U1', text: 'start', reply_count: 3, latest_reply: ts(1200) },
        // A top-level mention in the window, already answered with a reaction.
        { ts: ts(1100), user: 'U1', text: `<@${BOT}> done`, reactions: [{ name: 'white_check_mark', users: [BOT] }] },
        // A top-level mention before the window.
        { ts: ts(900), user: 'U1', text: `<@${BOT}> old` },
      ],
      C2: [{ ts: ts(1300), user: 'U2', text: `<@${BOT}> top`, files: [{ name: 'a.png' }] }],
    },
    replies: {
      [`C1/${ts(10)}`]: [
        { ts: ts(10), user: 'U1', text: 'start' },
        { ts: ts(1150), user: 'U1', text: `<@${BOT}> answered`, thread_ts: ts(10) },
        { ts: ts(1160), user: BOT, text: 'here you go', thread_ts: ts(10) },
        { ts: ts(1200), user: 'U1', text: `<@${BOT}> missed`, thread_ts: ts(10) },
      ],
    },
  });
  const got = await findMissed({ client, botUserId: BOT, since, until, log: quiet });
  assert.deepEqual(got.map((m) => [m.channel, m.ts, m.thread_ts]), [
    ['C1', ts(1200), ts(10)],
    ['C2', ts(1300), undefined],
  ]);
  assert.deepEqual(got[1].files, [{ name: 'a.png' }]);
  const replies = client.calls.filter(([k]) => k === 'replies');
  assert.equal(replies.length, 1, 'only threads active in the window are opened');
  assert.equal(replies[0][1].oldest, '1000.000000');
});

test('a channel that cannot be read is skipped, not fatal', async () => {
  const client = fakeClient({
    channels: [{ id: 'BAD' }, { id: 'C2' }],
    history: { C2: [{ ts: ts(1300), user: 'U2', text: `<@${BOT}> top` }] },
    replies: {},
    fail: new Set(['BAD']),
  });
  const warned = [];
  const got = await findMissed({ client, botUserId: BOT, since: 1000e3, until: 1600e3, log: { warn: (s) => warned.push(s) } });
  assert.equal(got.length, 1);
  assert.match(warned[0], /could not read BAD: not_in_channel/);
});

function catchupWith(history) {
  const client = fakeClient({ channels: [{ id: 'C1' }], history: { C1: history }, replies: {} });
  const seen = createSeen();
  const sent = [];
  const lines = [];
  const catchUp = createCatchup({
    client, botUserId: BOT, seen,
    dispatch: (m) => { sent.push(m.ts); },
    isInterrupt: (text) => /!stop/.test(text),
    now: () => 1600e3,
    log: { log: (s) => lines.push(s), error: (s) => lines.push(s), warn() {} },
  });
  return { catchUp, seen, sent, lines };
}

test('catch-up dispatches each missed mention once, across overlapping scans', async () => {
  const h = catchupWith([{ ts: ts(1300), user: 'U1', text: `<@${BOT}> do it` }]);
  await Promise.all([h.catchUp(1000e3, 'reconnect'), h.catchUp(1000e3, 'reconnect')]);
  assert.deepEqual(h.sent, [ts(1300)]);
});

test('a mention already seen live is not answered again', async () => {
  const h = catchupWith([{ ts: ts(1300), user: 'U1', text: `<@${BOT}> do it` }]);
  h.seen.claim('C1', ts(1300));
  await h.catchUp(1000e3, 'reconnect');
  assert.deepEqual(h.sent, []);
});

test('a late interrupt is never replayed', async () => {
  const h = catchupWith([{ ts: ts(1300), user: 'U1', text: `<@${BOT}> !stop`, thread_ts: ts(1) }]);
  await h.catchUp(1000e3, 'reconnect');
  assert.deepEqual(h.sent, []);
  assert.ok(h.lines.some((l) => /interrupt; not replaying/.test(l)));
});

test('a reconnect with nothing missed logs nothing', async () => {
  const h = catchupWith([]);
  await h.catchUp(1000e3, 'reconnect');
  assert.deepEqual(h.lines, []);
});

test('the late note gives the send time in UTC', () => {
  assert.match(lateNote('1793005169.599299'), /sent at 2026-10-26T08:59:29Z UTC and reached you late/);
});
