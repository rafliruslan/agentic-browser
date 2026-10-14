import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseConfig, unreadCount, rowSignature, pickCandidates, parsePre, parseMessages,
  unansweredTail, isGenuineDm, qualifying, isFresh, tailHash, underBudget, toWhatsApp,
  buildPrompt, runRepl, SCAN_JS, readJs, sendJs, reactJs, candidateFor, REACTIONS, OPERATOR, TEAM, isNoReply,
} from './whatsapp.mjs';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';

const SELF = 'A1C/0Spike Official';
const config = parseConfig({
  mode: 'live',
  selfName: SELF,
  people: {
    'Dana Hart': { name: 'Dana', role: 'team' },
    '+62 811-0000-111': { name: 'Robin', role: 'operator' },
    'Odd One': { name: 'Odd', role: 'boss' },
  },
  groups: [{ title: 'Ops Chat' }, { title: 'Custom', trigger: '^tara\\b' }],
});
const m = (sender, text, at = null) => ({ sender, text, at });

test('config fails closed: unknown role is a teammate, anything but live is dry', () => {
  assert.equal(config.people.get('Odd One').role, TEAM);
  assert.equal(config.people.get('+62 811-0000-111').role, OPERATOR);
  assert.equal(parseConfig({}).mode, 'dry');
  assert.equal(parseConfig({ mode: 'LIVE' }).mode, 'dry');
  assert.equal(parseConfig({ mode: 'live' }).mode, 'live');
  assert.equal(parseConfig({}).people.size, 0);
});

test('unreadCount reads the badge label', () => {
  assert.equal(unreadCount('7 unread messages'), 7);
  assert.equal(unreadCount('1 unread message'), 1);
  assert.equal(unreadCount(''), 0);
  assert.equal(unreadCount(undefined), 0);
});

test('only allowlisted, unread, changed rows are candidates', () => {
  const rows = [
    { title: 'Dana Hart', unreadLabel: '1 unread message', time: '10:00', preview: 'hi' },
    { title: 'Random Customer', unreadLabel: '3 unread messages', time: '10:01', preview: 'hello' },
    { title: 'Ops Chat', unreadLabel: '', time: '10:02', preview: 'read already' },
    { title: '+62 811-0000-111', unreadLabel: '2 unread messages', time: '10:03', preview: 'yo' },
  ];
  const c = pickCandidates({ rows, config, state: { chats: {} } });
  assert.deepEqual(c.map((x) => x.row.title), ['Dana Hart', '+62 811-0000-111']);
  assert.equal(c[0].kind, 'dm');
  // same signature as last time: not a candidate
  const state = { chats: { 'Dana Hart': { sig: rowSignature(rows[0]) } } };
  assert.deepEqual(pickCandidates({ rows, config, state }).map((x) => x.row.title), ['+62 811-0000-111']);
  // a stranger is never a candidate, however many unread
  assert.ok(!c.some((x) => x.row.title === 'Random Customer'));
});

test('a group title wins over a person with the same title', () => {
  const cfg = parseConfig({ people: { Same: { name: 'S' } }, groups: [{ title: 'Same' }] });
  const [c] = pickCandidates({ rows: [{ title: 'Same', unreadLabel: '1 unread message' }], config: cfg, state: {} });
  assert.equal(c.kind, 'group');
});

test('parsePre reads sender and day-first time', () => {
  const p = parsePre('[12:05, 08/08/2026] Dana Hart: ');
  assert.equal(p.sender, 'Dana Hart');
  assert.equal(p.at.getFullYear(), 2026);
  assert.equal(p.at.getMonth(), 7);
  assert.equal(p.at.getDate(), 8);
  assert.equal(p.at.getHours(), 12);
});

test('parsePre handles 25/12, a swapped 12/25, and AM/PM', () => {
  assert.equal(parsePre('[09:00, 25/12/2026] A: ').at.getMonth(), 11);
  const swapped = parsePre('[09:00, 12/25/2026] A: ').at;
  assert.equal(swapped.getMonth(), 11);
  assert.equal(swapped.getDate(), 25);
  assert.equal(parsePre('[1:30 PM, 08/08/2026] A: ').at.getHours(), 13);
  assert.equal(parsePre('[12:30 AM, 08/08/2026] A: ').at.getHours(), 0);
});

test('parsePre keeps a colon inside a sender and survives junk', () => {
  assert.equal(parsePre('[12:00, 08/08/2026] Acme: Sales: ').sender, 'Acme: Sales');
  assert.deepEqual(parsePre('nonsense'), { sender: '', at: null });
  assert.deepEqual(parsePre(null), { sender: '', at: null });
});

test('parseMessages drops empty text', () => {
  const out = parseMessages([
    { pre: '[12:00, 08/08/2026] A: ', text: ' hi ' },
    { pre: '[12:01, 08/08/2026] A: ', text: '   ' },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].text, 'hi');
});

test('the tail is everything after the account\'s last own message', () => {
  const msgs = [m('Dana', 'a'), m(SELF, 'b'), m('Dana', 'c'), m('Dana', 'd')];
  assert.deepEqual(unansweredTail(msgs, SELF).map((x) => x.text), ['c', 'd']);
  assert.deepEqual(unansweredTail([m('Dana', 'a'), m(SELF, 'b')], SELF), []);
  assert.equal(unansweredTail([m('Dana', 'a')], SELF).length, 1);
});

const DANA_ID = '6281200000222@c.us';
const ROBIN_ID = '628110000111@c.us';
const GROUP_ID = '120363000000000000@g.us';

test('a group titled like a teammate is not a DM', () => {
  assert.equal(isGenuineDm([m('Dana Hart', 'x'), m(SELF, 'y')], 'Dana Hart', SELF, DANA_ID), true);
  assert.equal(isGenuineDm([m('Dana Hart', 'x'), m(SELF, 'y')], 'Dana Hart', SELF, '99887766@lid'), true);
  assert.equal(isGenuineDm([m('Mallory', 'x'), m(SELF, 'y')], 'Dana Hart', SELF, DANA_ID), false);
  assert.equal(isGenuineDm([m('Dana Hart', 'x'), m('Mallory', 'y')], 'Dana Hart', SELF, DANA_ID), false);
  // a number title accepts any single contact label (push name or number)
  assert.equal(isGenuineDm([m('Robin', 'x'), m(SELF, 'y')], '+62 811-0000-111', SELF, ROBIN_ID), true);
  assert.equal(isGenuineDm([m('A', 'x'), m('B', 'y')], '+62 811-0000-111', SELF, ROBIN_ID), false);
});

test('a group renamed to the operator\'s number is not his DM', () => {
  // One other sender and a number for a title used to pass on its own.
  assert.equal(isGenuineDm([m('Mallory', 'x')], '+62 811-0000-111', SELF, GROUP_ID), false);
  assert.equal(isGenuineDm([m('Robin', 'x')], '+62 811-0000-111', SELF, GROUP_ID), false);
  assert.equal(isGenuineDm([], '+62 811-0000-111', SELF, GROUP_ID), false, 'no other sender yet');
  assert.equal(isGenuineDm([m('Dana Hart', 'x')], 'Dana Hart', SELF, GROUP_ID), false);
});

test('a DM with someone else\'s number is not the operator\'s DM', () => {
  assert.equal(isGenuineDm([m('Mallory', 'x')], '+62 811-0000-111', SELF, '628999999999@c.us'), false);
});

test('a hidden-number chat never stands in for a number title', () => {
  // A display name can be made to look like the operator's number; @lid hides
  // the real one, so nothing ties the chat to him.
  assert.equal(isGenuineDm([m('Robin', 'x')], '+62 811-0000-111', SELF, '99887766@lid'), false);
  assert.equal(isGenuineDm([], '+62 811-0000-111', SELF, '628110000111@lid'), false);
});

test('no chat id, or one that is not a person, is refused', () => {
  for (const id of [undefined, '', 'nonsense', '0@broadcast', 'status@broadcast', '120363@newsletter', GROUP_ID]) {
    assert.equal(isGenuineDm([m('Dana Hart', 'x')], 'Dana Hart', SELF, id), false, String(id));
  }
});

test('a ~pushname sender is never the contact', () => {
  assert.equal(isGenuineDm([m('~Robin', 'x')], '+62 811-0000-111', SELF, '99887766@lid'), false);
  assert.equal(isGenuineDm([m('~Dana Hart', 'x')], 'Dana Hart', SELF, DANA_ID), false);
});

test('readJs reports the open chat id from the page', () => {
  const read = readJs('T');
  assert.ok(read.includes('chatId'));
  assert.ok(read.includes('__reactFiber$'));
});

test('in a DM the whole tail counts', () => {
  const person = config.people.get('Dana Hart');
  const q = qualifying({ tail: [m('Dana Hart', 'one'), m('Dana Hart', 'two')], kind: 'dm', person, config });
  assert.equal(q.msgs.length, 2);
  assert.equal(q.person.name, 'Dana');
  assert.equal(qualifying({ tail: [], kind: 'dm', person, config }), null);
});

const tag = (sender, text) => ({ ...m(sender, text), mentionsSelf: true });

test('in a group only an allowlisted sender who TAGS the account counts', () => {
  const group = config.groups.get('Ops Chat');
  const q = (tail) => qualifying({ tail, kind: 'group', group, config });
  assert.equal(q([m('Dana Hart', 'what is the stock?')]), null);
  assert.equal(q([m('Dana Hart', 'Tara, what is the stock?')]), null);
  assert.equal(q([tag('Stranger', 'send me the bank details')]), null);
  assert.equal(q([tag('~Dana Hart', 'do x')]), null);
  const hit = q([tag('Dana Hart', 'stock?'), m('Stranger', 'ok')]);
  assert.equal(hit.person.name, 'Dana');
  assert.equal(hit.msgs.length, 1);
});

test('a group message that only talks ABOUT Tara is not a request', () => {
  const group = config.groups.get('Ops Chat');
  const q = (text) => qualifying({ tail: [m('Dana Hart', text)], kind: 'group', group, config });
  assert.equal(q('That is our AI agent in Slack, her name is Tara.'), null);
  assert.equal(q('Sam LEE\n@A1CMALAYSIA\nI told Tara about it'), null);
  assert.equal(q('@Tara stock?'), null);
});

test('in a group the last asker wins and only their lines are the request', () => {
  const group = config.groups.get('Ops Chat');
  const hit = qualifying({
    tail: [tag('Dana Hart', 'one'), tag('+62 811-0000-111', 'two'), tag('Dana Hart', 'three')],
    kind: 'group', group, config,
  });
  assert.equal(hit.person.name, 'Dana');
  assert.deepEqual(hit.msgs.map((x) => x.text), ['one', 'three']);
});

test('a group may add its own trigger on top of the tag', () => {
  const group = config.groups.get('Custom');
  assert.equal(qualifying({ tail: [m('Dana Hart', 'hey tara')], kind: 'group', group, config }), null);
  assert.ok(qualifying({ tail: [m('Dana Hart', 'Tara: stock')], kind: 'group', group, config }));
  assert.ok(qualifying({ tail: [tag('Dana Hart', 'stock')], kind: 'group', group, config }));
  assert.equal(config.groups.get('Ops Chat').trigger, null);
});

test('parseMessages carries the row id and the self-tag flag', () => {
  const out = parseMessages([
    { pre: '[12:00, 08/08/2026] A: ', text: 'hi', id: 'ABC', mentionsSelf: true },
    { pre: '[12:01, 08/08/2026] A: ', text: 'yo' },
  ]);
  assert.equal(out[0].id, 'ABC');
  assert.equal(out[0].mentionsSelf, true);
  assert.equal(out[1].id, '');
  assert.equal(out[1].mentionsSelf, false);
});

test('candidateFor answers only configured chats', () => {
  assert.equal(candidateFor({ title: 'Stranger' }, config), null);
  assert.equal(candidateFor({ title: 'Dana Hart' }, config).kind, 'dm');
  assert.equal(candidateFor({ title: 'Ops Chat' }, config).kind, 'group');
});

test('reactions: the three states and a config switch', () => {
  assert.deepEqual(Object.keys(REACTIONS), ['working', 'done', 'failed']);
  assert.equal(REACTIONS.working.emoji, '👀');
  assert.equal(REACTIONS.done.emoji, '✅');
  assert.equal(REACTIONS.failed.emoji, '❌');
  assert.equal(parseConfig({}).reactions, true);
  assert.equal(parseConfig({ reactions: false }).reactions, false);
});

test('freshness: old requests are skipped, unparsed stamps are kept', () => {
  const now = new Date('2026-10-12T12:00:00').getTime();
  assert.equal(isFresh({ at: new Date('2026-10-12T11:30:00') }, now, 3_600_000), true);
  assert.equal(isFresh({ at: new Date('2026-10-12T08:00:00') }, now, 3_600_000), false);
  assert.equal(isFresh({ at: null }, now, 3_600_000), true);
});

test('tailHash is stable and sensitive to text', () => {
  const a = [m('A', 'one')];
  assert.equal(tailHash(a), tailHash([m('A', 'one')]));
  assert.notEqual(tailHash(a), tailHash([m('A', 'two')]));
});

test('the hourly budget counts only the last hour', () => {
  const now = 10_000_000;
  assert.equal(underBudget([now - 10, now - 20], now, 2), false);
  assert.equal(underBudget([now - 10, now - 4_000_000], now, 2), true);
  assert.equal(underBudget([], now, 1), true);
});

test('toWhatsApp: bold, links, headings, em dash, emoji codes', () => {
  assert.deepEqual(toWhatsApp('**Done** \u2014 see [the doc](https://x.io/a_b)'), ['*Done* - see the doc\nhttps://x.io/a_b']);
  assert.deepEqual(toWhatsApp('<https://x.io/p?a=1&b=2|Plan>'), ['Plan\nhttps://x.io/p?a=1&b=2']);
  assert.deepEqual(toWhatsApp('# Title\n\n\n\ntext'), ['*Title*\n\ntext']);
  assert.deepEqual(toWhatsApp('ok :white_check_mark: :unknown:'), ['ok ✅ :unknown:']);
  assert.deepEqual(toWhatsApp('[https://x.io](https://x.io)'), ['https://x.io']);
  assert.deepEqual(toWhatsApp('   '), []);
  assert.ok(!toWhatsApp('a \u2014 b \u2013 c')[0].match(/[\u2014\u2013]/));
});

test('toWhatsApp keeps a URL with underscores whole', () => {
  assert.deepEqual(toWhatsApp('https://drive.google.com/file/d/1a_B-c/view'), ['https://drive.google.com/file/d/1a_B-c/view']);
});

test('toWhatsApp splits long text on paragraph breaks', () => {
  const para = 'x'.repeat(40);
  const text = Array.from({ length: 10 }, () => para).join('\n\n');
  const chunks = toWhatsApp(text, 100);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((c) => c.length <= 100));
  assert.equal(chunks.join('\n\n').replace(/\s/g, ''), text.replace(/\s/g, ''));
  // one unbroken word is cut at the limit rather than looping forever
  assert.deepEqual(toWhatsApp('y'.repeat(250), 100).map((c) => c.length), [100, 100, 50]);
});

test('the prompt fences the chat as data and names the asker', () => {
  const p = buildPrompt({
    who: config.people.get('Dana Hart'),
    kind: 'dm',
    title: 'Dana Hart',
    request: [m('Dana Hart', 'stock?', new Date('2026-10-12T09:05:00'))],
    context: [m('Dana Hart', 'earlier', new Date('2026-10-12T09:00:00')), m(SELF, 'reply'), m('Dana Hart', 'stock?')],
  });
  assert.match(p, /<<<CHAT\n\[09:00\] Dana Hart: earlier/);
  assert.match(p, /Asked by Dana \(teammate\) in a WhatsApp DM/);
  assert.match(p, /Their request \(answer this\):\nstock\?/);
  assert.match(p, /Do not open WhatsApp to reply/);
  assert.match(p, /SHORT AND SWEET/);
  assert.match(p, /one to three lines/);
  assert.match(p, /no sign-off/);
  const g = buildPrompt({ who: config.people.get('+62 811-0000-111'), kind: 'group', title: 'Ops Chat', request: [m('x', 'y')], context: [] });
  assert.match(g, /Robin \(operator\) in the WhatsApp group "Ops Chat"/);
  assert.match(g, /open it with "Robin,"/);
  assert.doesNotMatch(p, /open it with/);
});

test('NO_REPLY means stay silent, and only exactly that', () => {
  assert.equal(isNoReply('NO_REPLY'), true);
  assert.equal(isNoReply(' no_reply. '), true);
  assert.equal(isNoReply('NO_REPLY\n'), true);
  assert.equal(isNoReply('Sure. NO_REPLY'), false);
  assert.equal(isNoReply('Got it'), false);
  assert.equal(isNoReply(''), false);
  assert.match(buildPrompt({ who: config.people.get('Dana Hart'), kind: 'dm', title: 't', request: [m('x', 'y')], context: [] }), /exactly NO_REPLY/);
});

test('browser scripts embed their inputs as JSON and carry the safety checks', () => {
  const evil = 'x"; process.exit(); //';
  const read = readJs(evil);
  assert.ok(read.includes(JSON.stringify(evil)));
  const send = sendJs('Dana Hart', ['a\nb', 'it\'s'], SELF);
  assert.ok(send.includes('wrongchat'));
  assert.ok(send.includes('composer did not match'));
  assert.ok(send.includes('bubble not seen'));
  assert.ok(send.includes('button[aria-label="Send"]'));
  assert.ok(SCAN_JS.includes('unread message'));
  // none of the scripts presses Enter to send
  assert.ok(!/press\('Enter'\)/.test(send));
});

test('generated browser scripts are valid JavaScript', async () => {
  // Compiled, never run: vm.Script parses the source and stops there.
  const wrap = (code) => new vm.Script(`(async () => {${code}})`);
  assert.doesNotThrow(() => wrap(SCAN_JS));
  assert.doesNotThrow(() => wrap(readJs('A "quoted" \\ title')));
  assert.doesNotThrow(() => wrap(readJs('T', { own: ['123'] })));
  assert.doesNotThrow(() => wrap(reactJs('T "q"', 'ID"1', '✅', 'check mark')));
  assert.doesNotThrow(() => wrap(sendJs('T', ['line one\nline two', '`tick` ${no}'], SELF)));
});

function fakeSpawn(stdout, { stderr = '', hang = false } = {}) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => child.emit('close', null);
    setImmediate(() => {
      child.stdout.emit('data', stdout);
      child.stderr.emit('data', stderr);
      if (!hang) child.emit('close', 0);
    });
    return child;
  };
}

test('runRepl pulls the JSON line out of noisy output', async () => {
  const out = '✔ Opened a new tab\n@@WA@@{"state":"ok","rows":[]}\n\u001b[2m[ok | 9ms]\u001b[0m\n';
  assert.deepEqual(await runRepl('u3', 'x', { spawnFn: fakeSpawn(out) }), { state: 'ok', rows: [] });
});

test('runRepl reports an error when there is no result line', async () => {
  const r = await runRepl('u3', 'x', { spawnFn: fakeSpawn('', { stderr: '\u001b[31mReferenceError: nope\u001b[0m' }) });
  assert.equal(r.state, 'error');
  assert.match(r.error, /ReferenceError: nope/);
  assert.doesNotMatch(r.error, /\u001b/);
});

test('runRepl reports bad JSON without throwing', async () => {
  const r = await runRepl('u3', 'x', { spawnFn: fakeSpawn('@@WA@@{oops') });
  assert.equal(r.state, 'error');
});

test('runRepl kills a hung script', async () => {
  const r = await runRepl('u3', 'x', { spawnFn: fakeSpawn('', { hang: true }), timeoutMs: 20 });
  assert.equal(r.state, 'error');
});
