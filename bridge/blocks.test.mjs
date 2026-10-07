import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBlocks, parseInline } from './blocks.mjs';

const sections = (text) => buildBlocks(text)[0].elements;

test('parseInline returns plain text unchanged', () => {
  assert.deepEqual(parseInline('hello there'), [{ type: 'text', text: 'hello there' }]);
});

test('parseInline marks bold', () => {
  assert.deepEqual(parseInline('*Sale:* Fina'), [
    { type: 'text', text: 'Sale:', style: { bold: true } },
    { type: 'text', text: ' Fina' },
  ]);
});

test('parseInline marks code and leaves its contents literal', () => {
  assert.deepEqual(parseInline('order `10&34`'), [
    { type: 'text', text: 'order ' },
    { type: 'text', text: '10&34', style: { code: true } },
  ]);
});

test('parseInline marks italic', () => {
  assert.deepEqual(parseInline('_Focus time_'), [
    { type: 'text', text: 'Focus time', style: { italic: true } },
  ]);
});

test('parseInline builds a labelled link', () => {
  assert.deepEqual(parseInline('see <https://a1c.io|the site>'), [
    { type: 'text', text: 'see ' },
    { type: 'link', url: 'https://a1c.io', text: 'the site' },
  ]);
});

test('parseInline builds a bare link', () => {
  assert.deepEqual(parseInline('<https://a1c.io>'), [{ type: 'link', url: 'https://a1c.io' }]);
});

// A mention must stay a real mention, not the raw id.
test('parseInline builds a user mention', () => {
  assert.deepEqual(parseInline('hi <@U01EXAMPLE1>'), [
    { type: 'text', text: 'hi ' },
    { type: 'user', user_id: 'U01EXAMPLE1' },
  ]);
});

// rich_text takes literal characters, unlike mrkdwn which needs them escaped.
test('parseInline decodes escaped entities', () => {
  assert.deepEqual(parseInline('Product &amp; Engineering'), [
    { type: 'text', text: 'Product & Engineering' },
  ]);
});

test('buildBlocks returns null for empty input', () => {
  assert.equal(buildBlocks(''), null);
  assert.equal(buildBlocks('   \n  '), null);
  assert.equal(buildBlocks(null), null);
});

test('buildBlocks wraps everything in one rich_text block', () => {
  const blocks = buildBlocks('hello');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'rich_text');
});

// The whole point: a real list, not a literal bullet character.
test('buildBlocks turns bullet lines into a native list', () => {
  const els = sections('• first\n• second');
  assert.equal(els.length, 1);
  assert.equal(els[0].type, 'rich_text_list');
  assert.equal(els[0].style, 'bullet');
  assert.equal(els[0].elements.length, 2);
  assert.deepEqual(els[0].elements[0].elements, [{ type: 'text', text: 'first' }]);
});

test('buildBlocks accepts hyphen markers as bullets too', () => {
  const els = sections('- first\n- second');
  assert.equal(els[0].type, 'rich_text_list');
  assert.equal(els[0].style, 'bullet');
});

test('buildBlocks builds an ordered list', () => {
  const els = sections('1. first\n2. second');
  assert.equal(els[0].type, 'rich_text_list');
  assert.equal(els[0].style, 'ordered');
  assert.equal(els[0].elements.length, 2);
});

test('buildBlocks keeps a lead line separate from the list', () => {
  const els = sections('Seven things, Captain\n\n• first\n• second');
  assert.equal(els.length, 2);
  assert.equal(els[0].type, 'rich_text_section');
  assert.equal(els[1].type, 'rich_text_list');
});

test('buildBlocks does not mix bullet and ordered into one list', () => {
  const els = sections('• a\n1. b');
  assert.equal(els.length, 2);
  assert.equal(els[0].style, 'bullet');
  assert.equal(els[1].style, 'ordered');
});

test('buildBlocks joins consecutive prose lines into one section', () => {
  const els = sections('line one\nline two');
  assert.equal(els.length, 1);
  assert.deepEqual(els[0].elements, [
    { type: 'text', text: 'line one' },
    { type: 'text', text: '\n' },
    { type: 'text', text: 'line two' },
  ]);
});

test('buildBlocks handles a list followed by more prose', () => {
  const els = sections('• only item\n\nNext: do the thing');
  assert.equal(els[0].type, 'rich_text_list');
  assert.equal(els[1].type, 'rich_text_section');
});

test('buildBlocks carries formatting inside list items', () => {
  const els = sections('• *Sale:* Fina (`FINA5`)');
  const item = els[0].elements[0].elements;
  assert.deepEqual(item[0], { type: 'text', text: 'Sale:', style: { bold: true } });
  assert.deepEqual(item[2], { type: 'text', text: 'FINA5', style: { code: true } });
});

// Shape check against the real reply she sent, so the schema stays valid.
test('buildBlocks produces a valid shape for a real reply', () => {
  const blocks = buildBlocks(
    'Both checked, Captain :heartpulse:\n\n• `example.com` → *Example Domain*\n• `wikipedia.org` → *Wikipedia*\n\nNext: say the word.',
  );
  assert.equal(blocks[0].type, 'rich_text');
  const types = blocks[0].elements.map((e) => e.type);
  assert.deepEqual(types, ['rich_text_section', 'rich_text_list', 'rich_text_section']);
  for (const el of blocks[0].elements) {
    const groups = el.type === 'rich_text_list' ? el.elements : [el];
    for (const g of groups) {
      assert.equal(g.type, 'rich_text_section');
      assert.ok(Array.isArray(g.elements) && g.elements.length > 0);
    }
  }
});

// She writes things like *`PE-779`:* and a flat parser rendered the backticks
// as visible characters inside the bold run.
test('parseInline handles code nested inside bold', () => {
  assert.deepEqual(parseInline('*`PE-779`:*'), [
    { type: 'text', text: 'PE-779', style: { bold: true, code: true } },
    { type: 'text', text: ':', style: { bold: true } },
  ]);
});

test('parseInline handles bold nested inside italic', () => {
  assert.deepEqual(parseInline('_soft *hard* soft_'), [
    { type: 'text', text: 'soft ', style: { italic: true } },
    { type: 'text', text: 'hard', style: { italic: true, bold: true } },
    { type: 'text', text: ' soft', style: { italic: true } },
  ]);
});

test('parseInline still omits style on plain text', () => {
  assert.deepEqual(parseInline('plain'), [{ type: 'text', text: 'plain' }]);
});

// A fenced table must land in a monospaced block, not be parsed as prose.
test('buildBlocks turns a fenced block into preformatted', () => {
  const els = sections('Prices:\n```\n| MYR | SGD |\n| RM89 | S$29 |\n```');
  assert.equal(els[0].type, 'rich_text_section');
  assert.equal(els[1].type, 'rich_text_preformatted');
  assert.match(els[1].elements[0].text, /RM89/);
  assert.match(els[1].elements[0].text, /\|/);
});

test('buildBlocks keeps content from an unterminated fence', () => {
  const els = sections('```\nstill useful');
  assert.equal(els[0].type, 'rich_text_preformatted');
  assert.match(els[0].elements[0].text, /still useful/);
});

// --- bare URLs ----------------------------------------------------------------
// Drive, Linear and Slack links carry underscores. The italic rule used to read
// `_dEf-gH_` out of the middle of one and drop both underscores.

test('parseInline keeps a bare URL with underscores whole, as a link', () => {
  const url = 'https://docs.google.com/document/d/1AbC_dEf-gH_iJk/edit';
  assert.deepEqual(parseInline(`Doc: ${url} for review`), [
    { type: 'text', text: 'Doc: ' },
    { type: 'link', url },
    { type: 'text', text: ' for review' },
  ]);
});

test('parseInline leaves sentence punctuation outside a bare URL', () => {
  assert.deepEqual(parseInline('See https://example.com/a_b_c, then https://example.com/x?a=1&b=2.'), [
    { type: 'text', text: 'See ' },
    { type: 'link', url: 'https://example.com/a_b_c' },
    { type: 'text', text: ', then ' },
    { type: 'link', url: 'https://example.com/x?a=1&b=2' },
    { type: 'text', text: '.' },
  ]);
});

test('parseInline keeps a bracket that balances one inside the URL, and drops one that does not', () => {
  assert.deepEqual(parseInline('https://en.wikipedia.org/wiki/Foo_(bar)'), [
    { type: 'link', url: 'https://en.wikipedia.org/wiki/Foo_(bar)' },
  ]);
  assert.deepEqual(parseInline('(https://example.com/page)'), [
    { type: 'text', text: '(' },
    { type: 'link', url: 'https://example.com/page' },
    { type: 'text', text: ')' },
  ]);
});

test('parseInline turns a bare URL inside bold into a bold link', () => {
  assert.deepEqual(parseInline('*https://example.com/a_b*'), [
    { type: 'link', url: 'https://example.com/a_b', style: { bold: true } },
  ]);
});

test('parseInline does not read a URL inside backticks as a link', () => {
  assert.deepEqual(parseInline('`https://example.com/a_b`'), [
    { type: 'text', text: 'https://example.com/a_b', style: { code: true } },
  ]);
});

test('parseInline unescapes the url of an <url|label> token', () => {
  assert.deepEqual(parseInline('<https://example.com/x?a=1&amp;b=2|the page>'), [
    { type: 'link', url: 'https://example.com/x?a=1&b=2', text: 'the page' },
  ]);
});

test('a URL on its own line, then a blank line and a sentence, survives as two sections', () => {
  const url = 'https://linear.app/a1c/issue/OPS-324/some_title_here';
  const out = sections(`${url}\n\nWorth a look, Douglas.`);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0].elements, [{ type: 'link', url }]);
});
