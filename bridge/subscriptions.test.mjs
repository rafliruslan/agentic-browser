import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSubscriptionStore, shouldHandle, isStopPhrase, canInterrupt } from './subscriptions.mjs';

const BOT = 'UBOT1';
const OPERATOR = 'UEXAMPLE';
const base = (over = {}) => ({ user: OPERATOR, thread_ts: '1.0', ts: '1.5', text: 'and the other one?', ...over });

async function withStore(fn, opts = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'brave-subs-'));
  try {
    await fn(createSubscriptionStore({ path: join(dir, 'nested', 'subs.json'), ...opts }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('a followed thread is handled', () => {
  assert.equal(shouldHandle(base(), { botUserId: BOT, allowedUser: OPERATOR, subscribed: true }), true);
});

test('an unfollowed thread is ignored', () => {
  assert.equal(shouldHandle(base(), { botUserId: BOT, allowedUser: OPERATOR, subscribed: false }), false);
});

// Slack sends a mention as both app_mention and message.*, so handling it here
// too would run the task twice and post two answers.
test('a message containing a mention is left to app_mention', () => {
  const e = base({ text: `<@${BOT}> do it again` });
  assert.equal(shouldHandle(e, { botUserId: BOT, allowedUser: OPERATOR, subscribed: true }), false);
});

test('the agent never answers itself', () => {
  assert.equal(shouldHandle(base({ user: BOT }), { botUserId: BOT, allowedUser: OPERATOR, subscribed: true }), false);
  assert.equal(shouldHandle(base({ bot_id: 'B1' }), { botUserId: BOT, allowedUser: OPERATOR, subscribed: true }), false);
});

test('anyone other than the allowed user is ignored', () => {
  assert.equal(shouldHandle(base({ user: 'USOMEONE' }), { botUserId: BOT, allowedUser: OPERATOR, subscribed: true }), false);
});

// Edits and joins would otherwise re-run a task that already ran.
test('edits, deletions and joins are ignored', () => {
  for (const subtype of ['message_changed', 'message_deleted', 'channel_join', 'thread_broadcast']) {
    assert.equal(shouldHandle(base({ subtype }), { botUserId: BOT, allowedUser: OPERATOR, subscribed: true }), false, subtype);
  }
});

test('a file share still counts as a message', () => {
  assert.equal(shouldHandle(base({ subtype: 'file_share' }), { botUserId: BOT, allowedUser: OPERATOR, subscribed: true }), true);
});

// Starting a conversation still requires a mention.
test('a top-level message is never handled', () => {
  assert.equal(shouldHandle(base({ thread_ts: undefined }), { botUserId: BOT, allowedUser: OPERATOR, subscribed: true }), false);
  assert.equal(shouldHandle(base({ thread_ts: '1.5', ts: '1.5' }), { botUserId: BOT, allowedUser: OPERATOR, subscribed: true }), false);
});

test('a missing event is not handled', () => {
  assert.equal(shouldHandle(null, { botUserId: BOT, subscribed: true }), false);
});

test('stop phrases are recognised, ordinary text is not', () => {
  for (const s of ['stop', 'Stop.', 'quiet', 'stand down', 'that is all', 'never mind']) {
    assert.equal(isStopPhrase(s), true, s);
  }
  for (const s of ['stop the deploy', 'is it quiet today?', '', null]) {
    assert.equal(isStopPhrase(s), false, String(s));
  }
});

test('subscribe then isSubscribed round-trips', async () => {
  await withStore(async (s) => {
    assert.equal(await s.isSubscribed('1.0'), false);
    await s.subscribe('1.0', { channel: 'C1' });
    assert.equal(await s.isSubscribed('1.0'), true);
    assert.equal(await s.count(), 1);
  });
});

test('unsubscribe stops the following', async () => {
  await withStore(async (s) => {
    await s.subscribe('1.0');
    assert.equal(await s.unsubscribe('1.0'), true);
    assert.equal(await s.isSubscribed('1.0'), false);
    assert.equal(await s.unsubscribe('1.0'), false);
  });
});

// Without expiry, an offhand comment weeks later would wake the agent.
test('a subscription expires', async () => {
  let clock = 1000;
  await withStore(async (s) => {
    await s.subscribe('1.0');
    clock += 5000;
    assert.equal(await s.isSubscribed('1.0'), false);
  }, { now: () => clock, ttlMs: 1000 });
});

test('replying again refreshes the expiry', async () => {
  let clock = 1000;
  await withStore(async (s) => {
    await s.subscribe('1.0');
    clock += 900;
    await s.subscribe('1.0');
    clock += 900;
    assert.equal(await s.isSubscribed('1.0'), true);
  }, { now: () => clock, ttlMs: 1000 });
});

test('prune drops only what has expired', async () => {
  let clock = 1000;
  await withStore(async (s) => {
    await s.subscribe('old');
    clock += 5000;
    await s.subscribe('fresh');
    assert.equal(await s.prune(), 1);
    assert.equal(await s.isSubscribed('fresh'), true);
  }, { now: () => clock, ttlMs: 1000 });
});

test('a corrupt store is treated as empty', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'brave-subs-'));
  const path = join(dir, 'subs.json');
  try {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, 'not json');
    const s = createSubscriptionStore({ path });
    assert.equal(await s.isSubscribed('1.0'), false);
    await s.subscribe('1.0');
    assert.equal(await s.isSubscribed('1.0'), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- interrupting ----------------------------------------------------------
//
// shouldHandle ends with `return Boolean(subscribed)`, and a thread is only
// subscribed after the agent has REPLIED. So during the very run you want to
// stop, the thread is not yet subscribed and the message is dropped. Found by
// sending !stop to a live run and watching it count to 40 regardless.

test('an interrupt is allowed in a thread that is not subscribed yet', () => {
  assert.equal(
    canInterrupt({ user: 'U1', thread_ts: '1.1', ts: '2.2' }, { allowedUser: 'U1', botUserId: 'B1' }),
    true,
  );
});

test('an interrupt from anyone else is refused', () => {
  // Same security boundary as everything else: one person drives the agent.
  assert.equal(
    canInterrupt({ user: 'U2', thread_ts: '1.1', ts: '2.2' }, { allowedUser: 'U1', botUserId: 'B1' }),
    false,
  );
});

test('the agent cannot interrupt itself', () => {
  assert.equal(
    canInterrupt({ user: 'B1', thread_ts: '1.1', ts: '2.2' }, { allowedUser: 'U1', botUserId: 'B1' }),
    false,
  );
  assert.equal(
    canInterrupt({ bot_id: 'B9', thread_ts: '1.1', ts: '2.2' }, { allowedUser: 'U1', botUserId: 'B1' }),
    false,
  );
});

test('a top-level message is not an interrupt', () => {
  assert.equal(
    canInterrupt({ user: 'U1', ts: '2.2' }, { allowedUser: 'U1', botUserId: 'B1' }),
    false,
  );
});

test('an edit or a join is not an interrupt', () => {
  assert.equal(
    canInterrupt({ user: 'U1', thread_ts: '1.1', ts: '2.2', subtype: 'message_changed' },
      { allowedUser: 'U1', botUserId: 'B1' }),
    false,
  );
});

// --- answering only when tagged ---------------------------------------------

test('an untagged reply in a followed thread is read, not answered', () => {
  // She still receives it; shouldHandle only decides whether it is an
  // instruction. The next turn pastes the whole thread, so it is not lost.
  assert.equal(
    shouldHandle(base(), { botUserId: BOT, allowedUser: OPERATOR, subscribed: true, mentionOnly: true }),
    false,
  );
});

test('mention-only does not loosen any other check', () => {
  // Someone else, a bot, or a top-level message stays refused for its own
  // reason rather than being let through by the new flag.
  const opts = { botUserId: BOT, allowedUser: OPERATOR, subscribed: true, mentionOnly: false };
  assert.equal(shouldHandle(base({ user: 'USOMEONE' }), opts), false);
  assert.equal(shouldHandle(base({ bot_id: 'B1' }), opts), false);
  assert.equal(shouldHandle(base({ thread_ts: undefined }), opts), false);
});

test('turning mention-only off restores the follow-up reply', () => {
  assert.equal(
    shouldHandle(base(), { botUserId: BOT, allowedUser: OPERATOR, subscribed: true, mentionOnly: false }),
    true,
  );
});

test('stopping a live run still needs no tag', () => {
  // canInterrupt is the path !stop and !steer take, and it never asked for a
  // mention. Mention-only must not quietly disarm it.
  assert.equal(canInterrupt(base({ text: '!stop' }), { botUserId: BOT, allowedUser: OPERATOR }), true);
});
