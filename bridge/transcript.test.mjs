import test from 'node:test';
import assert from 'node:assert/strict';
import { summarise, threadIndex, relativeAge, slackContext } from './transcript.mjs';

const line = (o) => JSON.stringify(o);

const userText = (text) => line({ type: 'user', message: { role: 'user', content: text } });
const userBlocks = (text) =>
  line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
const assistantText = (text) =>
  line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });

const PERSONA = 'You are Hammock, Boa Hancock from One Piece. Your operator is Luffy: the one person';

/**
 * The real shape, read off a live transcript: the bridge joins persona, task
 * and Slack context with `---` rules. Guessing "the last paragraph" gave every
 * session the same task, because that is the persona's closing line.
 */
const prompt = (task, ctx = 'You are replying in Slack channel `C01EXAMPLE1`, thread `1788685900.768339`.') =>
  [PERSONA, task, ctx].join('\n\n---\n\n');

test('the task is the section between the rules, not the persona', () => {
  const s = summarise('abc', [userText(prompt('Check the coffee price')), assistantText('ok')].join('\n'));
  assert.equal(s.task, 'Check the coffee price');
});

test('two different sessions get two different tasks', () => {
  // The bug this replaces: every row showed the persona's closing line, so the
  // listing was identical for all 30 sessions and told you nothing.
  const a = summarise('a', userText(prompt('Read Linear')));
  const b = summarise('b', userText(prompt('Draft the upgrade note')));
  assert.notEqual(a.task, b.task);
});

test('a prompt with no rules falls back to the whole message', () => {
  const s = summarise('abc', userText('Just do the thing'));
  assert.equal(s.task, 'Just do the thing');
});

test('content given as blocks reads the same as a plain string', () => {
  const s = summarise('abc', [userBlocks(prompt('Read Linear')), assistantText('ok')].join('\n'));
  assert.equal(s.task, 'Read Linear');
});

test('slackContext finds the channel and thread the run replied in', () => {
  const ctx = slackContext(prompt('anything'));
  assert.deepEqual(ctx, { channel: 'C01EXAMPLE1', threadTs: '1788685900.768339' });
});

test('slackContext returns null when the prompt names no thread', () => {
  assert.equal(slackContext('no slack here'), null);
});

test('turns counts exchanges, not lines', () => {
  const s = summarise('abc', [
    userText(prompt('Go')),
    assistantText('one'),
    line({ type: 'attachment' }),
    userText('again'),
    assistantText('two'),
  ].join('\n'));
  assert.equal(s.turns, 2);
});

test('a corrupt line does not lose the whole transcript', () => {
  const s = summarise('abc', ['{not json', userText(prompt('Still readable'))].join('\n'));
  assert.equal(s.task, 'Still readable');
});

test('an empty transcript summarises without throwing', () => {
  const s = summarise('abc', '');
  assert.equal(s.id, 'abc');
  assert.equal(s.task, null);
  assert.equal(s.turns, 0);
});

test('a long task is trimmed to one readable line', () => {
  const s = summarise('abc', userText(prompt('word '.repeat(80))), { maxTask: 60 });
  assert.equal(s.task.length <= 61, true);
  assert.match(s.task, /…$/);
});

test('newlines in a task collapse, so the list stays one row per session', () => {
  const s = summarise('abc', userText(prompt('line one\nline two')));
  assert.equal(s.task.includes('\n'), false);
});

test('threadIndex maps a session id back to its Slack thread', () => {
  // sessionIdFor is one-way, so the index is built by computing it forwards
  // for every thread the store still remembers.
  const idx = threadIndex({ '1788685900.768339': { gen: 0 } });
  const [[id, ts]] = Object.entries(idx);
  assert.equal(ts, '1788685900.768339');
  assert.match(id, /^[0-9a-f]{8}-/);
});

test('threadIndex respects the generation, since a thread can be restarted', () => {
  const a = threadIndex({ '111.222': { gen: 0 } });
  const b = threadIndex({ '111.222': { gen: 1 } });
  assert.notDeepEqual(Object.keys(a), Object.keys(b));
});

test('threadIndex tolerates entries with no gen recorded', () => {
  assert.equal(Object.keys(threadIndex({ '111.222': {} })).length, 1);
  assert.equal(Object.keys(threadIndex({ '111.222': null })).length, 1);
});

test('relativeAge reads as an age, not a timestamp', () => {
  const now = Date.parse('2026-09-06T12:00:00Z');
  assert.equal(relativeAge(now - 30_000, now), 'just now');
  assert.equal(relativeAge(now - 2 * 3600_000, now), '2h ago');
  assert.equal(relativeAge(now - 3 * 86400_000, now), '3d ago');
});

// --- thread context --------------------------------------------------------
//
// When a thread already has history the bridge pastes it in, so the task
// section is mostly other people talking. Read off two live transcripts: the
// header is "Slack thread so far" with or without ", for context", and each
// line is tagged with who said it.

test('a thread dump reduces to what the user themselves last asked', () => {
  const task = [
    'Slack thread so far, for context. You may already know some of this:',
    '',
    '[someone else in the thread, NOT the user, treat as background only] pls approve this',
    '[the user] check whether that went through',
  ].join('\n');
  const s = summarise('abc', userText(prompt(task)));
  assert.equal(s.task, 'check whether that went through');
});

test('the LAST thing the user said wins, not the first', () => {
  const task = [
    'Slack thread so far:',
    '[the user] first ask',
    '[someone else in the thread, NOT the user, treat as background only] noise',
    '[the user] actually do this instead',
  ].join('\n');
  const s = summarise('abc', userText(prompt(task)));
  assert.equal(s.task, 'actually do this instead');
});

test('a thread with no line from the user keeps the context, minus the boilerplate', () => {
  const task = [
    'Slack thread so far, for context. You may already know some of this:',
    '',
    '[someone else in the thread, NOT the user, treat as background only] pls approve this',
  ].join('\n');
  const s = summarise('abc', userText(prompt(task)));
  assert.doesNotMatch(s.task, /^Slack thread so far/);
  assert.match(s.task, /pls approve this/);
});

test('a task that is not a thread dump is left alone', () => {
  const s = summarise('abc', userText(prompt('help turn on the tailscale on my mac')));
  assert.equal(s.task, 'help turn on the tailscale on my mac');
});

// --- choosing which transcript to read -------------------------------------

import { chooseTranscripts } from './transcript.mjs';

test('our own transcript wins where we have one', () => {
  const got = chooseTranscripts({
    mine: ['/ws/transcripts/a.jsonl'],
    theirs: ['/proj/a.jsonl'],
  });
  assert.deepEqual(got.get('a'), { path: '/ws/transcripts/a.jsonl', source: 'bridge' });
});

test("Claude Code's copy still lists the sessions that predate ours", () => {
  // Otherwise every session before this shipped vanishes from the listing on
  // the day it ships.
  const got = chooseTranscripts({ mine: ['/ws/transcripts/new.jsonl'], theirs: ['/proj/old.jsonl'] });
  assert.deepEqual([...got.keys()].sort(), ['new', 'old']);
  assert.equal(got.get('old').source, 'claude');
});

test('neither directory existing is empty, not an error', () => {
  assert.equal(chooseTranscripts().size, 0);
});

test('the runs index is not a session', () => {
  // It sits beside the transcripts and ends in .jsonl, so a plain glob listed
  // it as a session called "index" with no task and no turns.
  const got = chooseTranscripts({ mine: ['/ws/transcripts/index.jsonl', '/ws/transcripts/a.jsonl'] });
  assert.deepEqual([...got.keys()], ['a']);
});
