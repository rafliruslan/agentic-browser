import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMention, truncateOutput, formatResult, toSlackText, isDeadSession, isMissingSession, MAX_OUTPUT, stripAttribution } from './text.mjs';

// All observed in one live Slack reply: doubles rendered as literal asterisks
// and a Markdown image tag pointed at a local file path.
test('toSlackText converts double asterisks to Slack bold', () => {
  assert.equal(toSlackText('**Monday 10 Aug, 7 events:**'), '*Monday 10 Aug, 7 events:*');
});

test('toSlackText leaves single-asterisk bold alone', () => {
  assert.equal(toSlackText('*Sale:* Fina'), '*Sale:* Fina');
});

test('toSlackText strips Markdown image tags', () => {
  const out = toSlackText('Here it is\n![Monday](/Users/someone/.aside/u/0/tmp/mon.png)\ndone');
  assert.ok(!out.includes('!['));
  assert.ok(!out.includes('/Users/someone'));
  assert.match(out, /Here it is/);
  assert.match(out, /done/);
});

test('toSlackText converts Markdown links to Slack link syntax', () => {
  assert.equal(toSlackText('see [the docs](https://docs.aside.com)'), 'see <https://docs.aside.com|the docs>');
});

test('toSlackText turns headings into bold lines', () => {
  assert.equal(toSlackText('## Monday'), '*Monday*');
});

// Slack requires these escaped and renders them correctly. Decoding would break it.
test('toSlackText leaves HTML entities untouched', () => {
  assert.equal(toSlackText('Product &amp; Engineering, Ops &lt;&gt; AI'), 'Product &amp; Engineering, Ops &lt;&gt; AI');
});

test('toSlackText preserves bullets and code spans', () => {
  const input = '• *Sale:* Fina (`FINA5`), order `1034`';
  assert.equal(toSlackText(input), input);
});

test('toSlackText handles empty input', () => {
  assert.equal(toSlackText(''), '');
  assert.equal(toSlackText(null), '');
});

test('formatResult normalises the output it returns', () => {
  const out = formatResult({ ok: true, output: '**bold**', error: '', timedOut: false, sessionId: null });
  assert.equal(out, '*bold*');
});

test('parseMention strips a leading bot mention', () => {
  assert.equal(parseMention('<@U123> check the sheet', 'U123'), 'check the sheet');
});

test('parseMention strips a mention in the middle', () => {
  assert.equal(parseMention('hey <@U123> do it', 'U123'), 'hey do it');
});

test('parseMention returns empty string for a bare mention', () => {
  assert.equal(parseMention('<@U123>', 'U123'), '');
});

test('parseMention returns empty string for non-string input', () => {
  assert.equal(parseMention(undefined, 'U123'), '');
});

test('parseMention preserves newlines in multi-line prompts', () => {
  assert.equal(parseMention('<@U123> line one\nline two', 'U123'), 'line one\nline two');
});

test('parseMention strips any mention when botUserId is unknown', () => {
  assert.equal(parseMention('<@UABC123> go', undefined), 'go');
});

test('truncateOutput passes short text through unchanged', () => {
  assert.equal(truncateOutput('short'), 'short');
});

test('truncateOutput caps long text at the limit', () => {
  const result = truncateOutput('x'.repeat(5000));
  assert.ok(result.length <= MAX_OUTPUT);
  assert.match(result, /truncated/);
});

test('truncateOutput respects a custom limit', () => {
  const result = truncateOutput('y'.repeat(100), 50);
  assert.ok(result.length <= 50);
});

test('formatResult returns output on success', () => {
  const out = formatResult({ ok: true, output: 'all done', error: '', timedOut: false, sessionId: null });
  assert.equal(out, 'all done');
});

test('formatResult reports a timeout with whatever she had said', () => {
  const out = formatResult({ ok: false, output: 'partial', error: '', timedOut: true, sessionId: null });
  assert.match(out, /past the time limit/);
  assert.match(out, /still be finishing/);
  assert.match(out, /partial/);
});

test('formatResult omits the empty body when a timeout produced nothing', () => {
  const out = formatResult({ ok: false, output: '', error: '', timedOut: true, sessionId: null });
  assert.match(out, /past the time limit/);
  assert.ok(!out.includes('(no output)'));
});

test('formatResult detects a browser that is not reachable', () => {
  const out = formatResult({
    ok: false,
    output: '',
    error: 'connect ECONNREFUSED 127.0.0.1:9222',
    timedOut: false,
    sessionId: null,
  });
  assert.match(out, /browser isn't running/);
});

// Every CDP failure string must reach the "open the browser" message, not the
// generic one. A hint that stops matching is silent: the run still fails, the
// user just stops being told what to do about it.
test('every CDP hint produces the browser message', () => {
  const hints = [
    'econnrefused',
    'browser is not running',
    'no browser profile',
    'browser has been closed',
    'target page, context or browser has been closed',
    'failed to connect to the browser',
    'connect econnrefused 127.0.0.1:9222',
    'websocket error',
  ];
  for (const hint of hints) {
    const out = formatResult({ ok: false, output: '', error: hint, timedOut: false, sessionId: null });
    assert.match(out, /browser isn't running/, `hint did not match: ${hint}`);
  }
});

// The macOS harness's strings can never appear on Linux. If they ever come
// back, a real CDP outage would fall through to the generic failure text.
test('the retired Aside strings are gone', () => {
  const out = formatResult({
    ok: false,
    output: '',
    error: 'Chrome extension not connected for the requested browser profile',
    timedOut: false,
    sessionId: null,
  });
  assert.ok(!/browser isn't running/.test(out), 'stale Aside hint is still matching');
});

test('formatResult reports a generic failure with the stderr text', () => {
  const out = formatResult({ ok: false, output: '', error: 'boom', timedOut: false, sessionId: null });
  assert.match(out, /Failed/);
  assert.match(out, /boom/);
});

test('formatResult handles empty successful output', () => {
  const out = formatResult({ ok: true, output: '', error: '', timedOut: false, sessionId: null });
  assert.equal(out, '(no output)');
});

// Added after the Task 1 probe: the CLI reports failures in `output`, not `error`,
// and exits 0 while doing it. formatResult must surface those as failures.
test('formatResult surfaces a CLI error carried in output', () => {
  const out = formatResult({
    ok: false,
    output: ' • Error Session not found: abc123',
    error: '',
    timedOut: false,
    sessionId: null,
  });
  assert.match(out, /Failed/);
  assert.match(out, /Session not found/);
});

// Slack leaves a list hyphen as a hyphen; only the literal character renders.
test('toSlackText converts hyphen list markers to bullets', () => {
  const out = toSlackText('- *Title:* thing\n- *Team:* other');
  assert.equal(out, '• *Title:* thing\n• *Team:* other');
});

test('toSlackText leaves existing bullets alone', () => {
  assert.equal(toSlackText('• already a bullet'), '• already a bullet');
});

// A dash inside a sentence is not a list marker.
test('toSlackText does not touch mid-line hyphens', () => {
  assert.equal(toSlackText('10:00-11:30 sprint review'), '10:00-11:30 sprint review');
});

test('toSlackText does not mangle a horizontal rule or bare dash', () => {
  assert.equal(toSlackText('a\n---\nb'), 'a\n---\nb');
});

// Slack auto-links a bare domain and swallows adjacent bold markers:
// `*example.com:*` posts as `<http://example.com:*|example.com:*>`.
test('toSlackText backticks a bare domain trapped inside bold', () => {
  assert.equal(toSlackText('*example.com:* Example Domain'), '`example.com`: Example Domain');
});

test('toSlackText handles several domains in one bold span', () => {
  assert.equal(toSlackText('*example.com and wikipedia.org*'), '`example.com` and `wikipedia.org`');
});

test('toSlackText leaves bold without a domain alone', () => {
  assert.equal(toSlackText('*Sale:* Fina'), '*Sale:* Fina');
});

// Only bold spans are rewritten, so ordinary prose keeps its domains.
test('toSlackText does not touch a domain outside bold', () => {
  assert.equal(toSlackText('go to example.com now'), 'go to example.com now');
});

test('toSlackText leaves a bold span that already uses backticks or a link', () => {
  assert.equal(toSlackText('*`example.com` here*'), '*`example.com` here*');
  assert.equal(toSlackText('*<https://example.com|site> here*'), '*<https://example.com|site> here*');
});

// Version strings and file names live in prose and must survive untouched.
test('toSlackText does not mangle versions or filenames outside bold', () => {
  assert.equal(toSlackText('app v1.13.0 in runner.mjs'), 'app v1.13.0 in runner.mjs');
});

// Em dashes are banned in the operator's writing and she kept using them.
test('toSlackText replaces an em dash with a comma', () => {
  assert.equal(toSlackText('Sprint Review — you have not RSVP’d'), 'Sprint Review, you have not RSVP’d');  // em-dash-ok: the em dash is the input under test
});

test('toSlackText turns a dash between numbers into a range hyphen', () => {
  assert.equal(toSlackText('10:00–11:30 standup'), '10:00-11:30 standup');
  assert.equal(toSlackText('12:45 — 13:45 lunch'), '12:45-13:45 lunch');  // em-dash-ok: the em dash is the input under test
});

test('toSlackText leaves ordinary hyphens alone', () => {
  assert.equal(toSlackText('sign-out on Android'), 'sign-out on Android');
});

// A run killed by the network is not the user's problem to decode.
test('formatResult names a network failure plainly', () => {
  const out = formatResult({ ok: false, output: '', error: 'fetch failed', timedOut: false, sessionId: null });
  assert.match(out, /Lost the network/);
  assert.ok(!out.includes('fetch failed'));
});

// The real failure showed raw thinking and a websearch call in the channel.
test('formatResult hides raw thinking and tool traces', () => {
  const trace = "Thinking: The user needs infrastructure guidance given their setup\nwebsearch(objective: 'Current pricing for Hetzner')";
  const out = formatResult({ ok: false, output: trace, error: '', timedOut: false, sessionId: null });
  assert.match(out, /died before it finished/);
  assert.ok(!out.includes('Thinking:'));
  assert.ok(!out.includes('websearch('));
});

test('formatResult still shows a real diagnosis', () => {
  const out = formatResult({ ok: false, output: ' • Error Session not found: abc', error: '', timedOut: false, sessionId: null });
  assert.match(out, /Failed/);
  assert.match(out, /Session not found/);
});

test('formatResult handles a failure with nothing at all', () => {
  const out = formatResult({ ok: false, output: '', error: '', timedOut: false, sessionId: null });
  assert.match(out, /died before it finished/);
});

// A Markdown table rendered as literal pipes and dashes in the channel.
test('toSlackText fences a Markdown table so columns align', () => {
  const table = '| MYR | SGD | USD |\n|---|---|---|\n| RM89.99 | S$29.99 | $27.99 |';
  const out = toSlackText(table);
  assert.match(out, /^```/m);
  assert.ok(!out.includes('|---|'), 'separator row should be dropped');
  assert.match(out, /RM89\.99/);
  assert.match(out, /MYR/);
});

test('toSlackText leaves a single piped line alone', () => {
  assert.equal(toSlackText('a | b | c'), 'a | b | c');
});

// The session, not the request, is what failed.
test('isDeadSession spots a broken browser binding', () => {
  assert.equal(isDeadSession('Error: belongs to a different browser profile'), true);
  assert.equal(isDeadSession('BELONGS TO A DIFFERENT BROWSER PROFILE'), true);
});

test('isDeadSession ignores ordinary failures', () => {
  assert.equal(isDeadSession('fetch failed'), false);
  assert.equal(isDeadSession(''), false);
  assert.equal(isDeadSession(null), false);
});

// Aside evicts old sessions from state.db while keeping the log directory:
// measured 442 directories against 152 registered.
test('isMissingSession spots an evicted session id', () => {
  assert.equal(isMissingSession(' • Error Session not found: Lj5hm0dICistKQOi'), true);
  assert.equal(isMissingSession('session not found'), true);
});

test('isMissingSession ignores unrelated failures', () => {
  assert.equal(isMissingSession('fetch failed'), false);
  assert.equal(isMissingSession(''), false);
  assert.equal(isMissingSession(null), false);
});

// An evicted session is dead in the same way a broken profile is: never resume.
test('isDeadSession covers an evicted session too', () => {
  assert.equal(isDeadSession('Error Session not found: abc'), true);
});

// --- Slack's attribution suffix ---------------------------------------------
//
// Messages sent through the Claude Slack app arrive with an attribution
// appended INLINE: "stop" is delivered as "stop *Sent using* <@U0A8...>".
// isStopPhrase matches the whole message, so unfollowing a thread silently did
// nothing for anyone using that app. parseInterrupt had the same bug.

test('stripAttribution removes the inline suffix', () => {
  assert.equal(stripAttribution('stop *Sent using* <@U03EXAMPLEC>'), 'stop');
});

test('stripAttribution removes it on its own line too', () => {
  assert.equal(stripAttribution('stop\n*Sent using* <@U03EXAMPLEC>'), 'stop');
});

test('stripAttribution leaves an ordinary message alone', () => {
  assert.equal(stripAttribution('tell me what you are sending'), 'tell me what you are sending');
});

test('stripAttribution is anchored to the end', () => {
  const t = '*Sent using* <@U1> is what the footer says';
  assert.equal(stripAttribution(t), t);
});

test('stripAttribution handles empty input', () => {
  assert.equal(stripAttribution(''), '');
  assert.equal(stripAttribution(null), '');
});
