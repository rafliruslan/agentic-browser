import test from 'node:test';
import assert from 'node:assert/strict';
import { formatThread, composeTask, locationNote } from './thread.mjs';

const BOT = 'UBOT';
const OPERATOR = 'U01EXAMPLE1';
const OTHER = 'UTEAMMATE';

const msg = (user, text, extra = {}) => ({ user, text, ts: `${Math.random()}`, ...extra });

test('the allowed user is labelled the user', () => {
  const out = formatThread([msg(OPERATOR, 'check the sheet')], BOT, null, OPERATOR);
  assert.equal(out, '[the user] check the sheet');
});

test('the bot is labelled the agent', () => {
  const out = formatThread([msg(BOT, 'done')], BOT, null, OPERATOR);
  assert.match(out, /^\[the agent\]/);
});

// The whole point. One person commands the agent, and the transcript used to
// hand a teammate the same label, so their words read as that person's orders.
test('anyone else is labelled as not the user', () => {
  const out = formatThread([msg(OTHER, 'actually, cancel that')], BOT, null, OPERATOR);
  assert.ok(!out.includes('[the user]'), 'a teammate must not be labelled the user');
  assert.match(out, /NOT the user/);
  assert.match(out, /actually, cancel that/);
});

test('a mixed thread keeps the speakers apart', () => {
  const out = formatThread(
    [msg(OPERATOR, 'book it'), msg(OTHER, 'no, skip it'), msg(BOT, 'booked')],
    BOT, null, OPERATOR,
  );
  const [a, b, c] = out.split('\n');
  assert.match(a, /^\[the user\] book it/);
  assert.match(b, /NOT the user/);
  assert.match(c, /^\[the agent\] booked/);
});

// Callers that predate the parameter must not start mislabelling the one human.
test('without an allowedUser every human is still the user', () => {
  const out = formatThread([msg(OTHER, 'hello')], BOT, null);
  assert.equal(out, '[the user] hello');
});

test('an app posting under a bot_id counts as the agent', () => {
  const out = formatThread([msg(undefined, 'from an app', { bot_id: 'B1' })], BOT, null, OPERATOR);
  assert.match(out, /^\[the agent\]/);
});

test('the triggering message is skipped, it becomes the prompt', () => {
  const m = msg(OPERATOR, 'the prompt');
  assert.equal(formatThread([m], BOT, m.ts, OPERATOR), '');
});

test('placeholders never reach her context', () => {
  const out = formatThread(
    [msg(BOT, '⏳ running…'), msg(BOT, ':hourglass_flowing_sand: running…'), msg(OPERATOR, 'real')],
    BOT, null, OPERATOR,
  );
  assert.equal(out, '[the user] real');
});

test('raw user ids are stripped from the text', () => {
  const out = formatThread([msg(OPERATOR, '<@UBOT> do the thing')], BOT, null, OPERATOR);
  assert.equal(out, '[the user] do the thing');
});

test('empty and missing input is handled', () => {
  assert.equal(formatThread(null, BOT, null, OPERATOR), '');
  assert.equal(formatThread([], BOT, null, OPERATOR), '');
  assert.equal(formatThread([msg(OPERATOR, '   ')], BOT, null, OPERATOR), '');
});

test('locationNote names the channel and thread', () => {
  const note = locationNote({ channel: 'C1', threadTs: '123.4' });
  assert.match(note, /C1/);
  assert.match(note, /123\.4/);
});

test('locationNote is empty without a location', () => {
  assert.equal(locationNote({ channel: null, threadTs: '1' }), '');
  assert.equal(locationNote({ channel: 'C1', threadTs: null }), '');
});

test('composeTask carries both the prompt and the transcript', () => {
  const out = composeTask('do it', '[the user] earlier');
  assert.match(out, /do it/);
  assert.match(out, /earlier/);
});

// --- keeping the recent end of a long thread --------------------------------

import { recentReplies } from './thread.mjs';

/** A fake Slack that pages a thread the way conversations.replies does. */
function fakeSlack(messages, pageSize = 200) {
  const calls = [];
  return {
    calls,
    conversations: {
      async replies({ cursor }) {
        const start = cursor ? Number(cursor) : 0;
        calls.push(start);
        const slice = messages.slice(start, start + pageSize);
        const next = start + pageSize;
        return {
          messages: slice,
          has_more: next < messages.length,
          response_metadata: next < messages.length ? { next_cursor: String(next) } : {},
        };
      },
    },
  };
}

const msgs = (n) => Array.from({ length: n }, (_, i) => ({ ts: `${i}`, text: `m${i}` }));

test('a short thread comes back whole, in order', async () => {
  const got = await recentReplies(fakeSlack(msgs(5)), { channel: 'C', threadTs: '0', limit: 30 });
  assert.deepEqual(got.map((m) => m.text), ['m0', 'm1', 'm2', 'm3', 'm4']);
});

test('a long thread keeps the END, not the beginning', async () => {
  // Slack returns a thread oldest first, so asking for 30 used to return the
  // first 30 and lose the conversation that decides what she is being asked.
  const got = await recentReplies(fakeSlack(msgs(100)), { channel: 'C', threadTs: '0', limit: 5 });
  assert.equal(got.at(-1).text, 'm99');
  assert.equal(got.length, 5);
});

test('the parent survives the trim, since it is what the thread is about', async () => {
  const got = await recentReplies(fakeSlack(msgs(100)), { channel: 'C', threadTs: '0', limit: 5 });
  assert.equal(got[0].text, 'm0');
  assert.equal(got.filter((m) => m.ts === '0').length, 1, 'and is not duplicated');
});

test('the parent is not duplicated when the thread never needed trimming', async () => {
  const got = await recentReplies(fakeSlack(msgs(3)), { channel: 'C', threadTs: '0', limit: 30 });
  assert.equal(got.filter((m) => m.ts === '0').length, 1);
  assert.deepEqual(got.map((m) => m.text), ['m0', 'm1', 'm2']);
});

test('paging stops at maxPages rather than walking a huge thread forever', async () => {
  const slack = fakeSlack(msgs(10000), 200);
  await recentReplies(slack, { channel: 'C', threadTs: '0', limit: 30, maxPages: 3 });
  assert.equal(slack.calls.length, 3);
});

test('one page is one call: the common case costs nothing extra', async () => {
  const slack = fakeSlack(msgs(10));
  await recentReplies(slack, { channel: 'C', threadTs: '0' });
  assert.equal(slack.calls.length, 1);
});
