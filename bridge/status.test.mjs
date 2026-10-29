import test from 'node:test';
import assert from 'node:assert/strict';
import { react, unreact, settle, setStatus, splitOutcome, reactionFor, WORKING, DONE, PARTIAL, QUESTION, FAILED, ALL } from './status.mjs';
import { REPLY_NOTE } from './persona.mjs';

const slackErr = (code) => Object.assign(new Error(code), { data: { error: code } });

function fakeClient({ addErr, removeErr, statusErr, assistant = true } = {}) {
  const calls = [];
  const c = {
    calls,
    reactions: {
      add: async (a) => { calls.push(['add', a.name]); if (addErr) throw slackErr(addErr); return { ok: true }; },
      remove: async (a) => { calls.push(['remove', a.name]); if (removeErr) throw slackErr(removeErr); return { ok: true }; },
    },
  };
  if (assistant) {
    c.assistant = { threads: { setStatus: async (a) => { calls.push(['status', a.status]); if (statusErr) throw slackErr(statusErr); return { ok: true }; } } };
  }
  return c;
}

test('the markers are Slack shortcodes without colons', () => {
  for (const name of ALL) {
    assert.match(name, /^[a-z0-9_]+$/, `${name} must be a bare shortcode`);
  }
  assert.deepEqual(ALL, [WORKING, DONE, PARTIAL, QUESTION, FAILED]);
  assert.equal(new Set(ALL).size, ALL.length, 'every marker must mean one thing');
});

test('splitOutcome takes the status line off and says how it went', () => {
  assert.deepEqual(splitOutcome('Sent it.\n[status: done]'), { text: 'Sent it.', outcome: 'done' });
  assert.deepEqual(splitOutcome('Half.\n\n[Status: PARTIAL]  '), { text: 'Half.', outcome: 'partial' });
  assert.deepEqual(splitOutcome('No access.\n[status: blocked]'), { text: 'No access.', outcome: 'blocked' });
  assert.deepEqual(splitOutcome('Which one?\n[status: question]'), { text: 'Which one?', outcome: 'question' });
});

test('splitOutcome leaves a reply with no status line alone', () => {
  assert.deepEqual(splitOutcome('Just text.'), { text: 'Just text.', outcome: null });
  assert.deepEqual(splitOutcome(''), { text: '', outcome: null });
  assert.deepEqual(splitOutcome(undefined), { text: '', outcome: null });
});

// A status line in the wrong place must still never reach Slack.
test('splitOutcome strips a misplaced status line and trusts nothing from it', () => {
  const out = splitOutcome('First.\n[status: done]\nThen more.');
  assert.equal(out.outcome, null);
  assert.ok(!out.text.includes('[status'));
  assert.match(out.text, /First\./);
  assert.match(out.text, /Then more\./);
});

test('splitOutcome ignores a bracket that is not a status line', () => {
  assert.deepEqual(splitOutcome('See [status: unknown] here.'), { text: 'See [status: unknown] here.', outcome: null });
});

test('reactionFor never shows a failed run as done', () => {
  assert.equal(reactionFor({ ok: false, outcome: 'done', text: 'x' }), FAILED);
  assert.equal(reactionFor({ ok: false, outcome: null, text: '' }), FAILED);
});

test('reactionFor follows what the agent said about the request', () => {
  assert.equal(reactionFor({ ok: true, outcome: 'done', text: 'x' }), DONE);
  assert.equal(reactionFor({ ok: true, outcome: 'partial', text: 'x' }), PARTIAL);
  assert.equal(reactionFor({ ok: true, outcome: 'question', text: 'x' }), QUESTION);
  // Posted fine, but it says it could not do the thing: not a tick.
  assert.equal(reactionFor({ ok: true, outcome: 'blocked', text: 'x' }), FAILED);
});

test('reactionFor without a status line reads a closing question as waiting', () => {
  assert.equal(reactionFor({ ok: true, outcome: null, text: 'Found two.\nWhich one first?' }), QUESTION);
  assert.equal(reactionFor({ ok: true, outcome: null, text: 'Which one first? "A" or "B"?' }), QUESTION);
  assert.equal(reactionFor({ ok: true, outcome: null, text: 'Done. Sent to Sebastian.' }), DONE);
  assert.equal(reactionFor({ ok: true, outcome: null, text: '' }), DONE);
});

test('every status word the agent is told to use is one splitOutcome understands', () => {
  const words = [...REPLY_NOTE.matchAll(/\[status: (\w+)\]/g)].map((m) => m[1]);
  assert.deepEqual(words, ['done', 'partial', 'blocked', 'question']);
  for (const w of words) assert.equal(splitOutcome(`x\n[status: ${w}]`).outcome, w);
  assert.match(REPLY_NOTE, /yes or no question/i);
});

test('react adds the named reaction', async () => {
  const c = fakeClient();
  assert.equal(await react(c, { channel: 'C1', ts: '1.1', name: WORKING }), true);
  assert.deepEqual(c.calls, [['add', 'eyes']]);
});

// The scope is not granted until the app is reinstalled. The bridge must keep
// answering in the meantime.
test('react degrades quietly when the scope is missing', async () => {
  const warns = [];
  const c = fakeClient({ addErr: 'missing_scope' });
  assert.equal(await react(c, { channel: 'C1', ts: '1.1', name: WORKING, logger: { warn: (m) => warns.push(m) } }), false);
  assert.equal(warns.length, 0, 'a missing scope is expected, not worth a log line');
});

test('react treats already_reacted as success', async () => {
  const c = fakeClient({ addErr: 'already_reacted' });
  assert.equal(await react(c, { channel: 'C1', ts: '1.1', name: DONE }), true);
});

test('react logs an unexpected failure', async () => {
  const warns = [];
  const c = fakeClient({ addErr: 'ratelimited' });
  await react(c, { channel: 'C1', ts: '1.1', name: DONE, logger: { warn: (m) => warns.push(m) } });
  assert.equal(warns.length, 1);
  assert.match(warns[0], /ratelimited/);
});

test('react needs a channel, ts and name', async () => {
  const c = fakeClient();
  assert.equal(await react(c, { channel: 'C1', ts: '1.1' }), false);
  assert.equal(await react(null, { channel: 'C1', ts: '1.1', name: DONE }), false);
  assert.deepEqual(c.calls, []);
});

test('unreact treats no_reaction as nothing to do', async () => {
  const warns = [];
  const c = fakeClient({ removeErr: 'no_reaction' });
  assert.equal(await unreact(c, { channel: 'C1', ts: '1.1', name: WORKING, logger: { warn: (m) => warns.push(m) } }), false);
  assert.equal(warns.length, 0);
});

// Both markers showing at once reads as a half-finished run.
test('settle removes the working marker before adding the outcome', async () => {
  const c = fakeClient();
  await settle(c, { channel: 'C1', ts: '1.1', ok: true });
  assert.deepEqual(c.calls, [['remove', 'eyes'], ['add', 'white_check_mark']]);
});

test('settle uses the reaction it is given over the tick or the cross', async () => {
  const c = fakeClient();
  await settle(c, { channel: 'C1', ts: '1.1', ok: true, name: QUESTION });
  assert.deepEqual(c.calls, [['remove', 'eyes'], ['add', 'question']]);
});

test('settle marks a failure', async () => {
  const c = fakeClient();
  await settle(c, { channel: 'C1', ts: '1.1', ok: false });
  assert.deepEqual(c.calls, [['remove', 'eyes'], ['add', 'x']]);
});

test('setStatus sends the assistant thread status', async () => {
  const c = fakeClient();
  assert.equal(await setStatus(c, { channel: 'C1', threadTs: '1.0', status: 'Working…' }), true);
  assert.deepEqual(c.calls, [['status', 'Working…']]);
});

// Ordinary bots have no assistant surface. That is the normal case here.
test('setStatus is a no-op when the client has no assistant API', async () => {
  const c = fakeClient({ assistant: false });
  assert.equal(await setStatus(c, { channel: 'C1', threadTs: '1.0', status: 'x' }), false);
  assert.deepEqual(c.calls, []);
});

test('setStatus stays quiet on the expected refusals', async () => {
  for (const code of ['missing_scope', 'not_allowed_token_type', 'invalid_thread', 'channel_not_found']) {
    const warns = [];
    const c = fakeClient({ statusErr: code });
    assert.equal(await setStatus(c, { channel: 'C1', threadTs: '1.0', status: 'x', logger: { warn: (m) => warns.push(m) } }), false);
    assert.equal(warns.length, 0, `${code} should not warn`);
  }
});
