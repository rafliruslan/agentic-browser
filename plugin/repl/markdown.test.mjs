import test from 'node:test';
import assert from 'node:assert/strict';
import { toMarkdown, renderMarkdown, decodeEntities, absolute, looksLikeHtml } from './markdown.mjs';

test('script, style and head never reach the agent', () => {
  const { text } = toMarkdown('<head><title>t</title></head><body><script>var secret=1</script><style>.a{}</style><p>real</p></body>');
  assert.equal(text.includes('secret'), false);
  assert.equal(text.includes('.a{}'), false);
  assert.equal(text.includes('real'), true);
});

test('headings keep their level', () => {
  const { text } = toMarkdown('<h1>One</h1><h3>Three</h3>');
  assert.match(text, /^# One$/m);
  assert.match(text, /^### Three$/m);
});

test('a link becomes an index and the href is footnoted once', () => {
  const { text, links } = toMarkdown('<a href="https://a.test/x">Read</a>');
  assert.equal(text, '[Read][1]');
  assert.deepEqual(links, ['https://a.test/x']);
});

test('the same href twice keeps one index rather than paying twice', () => {
  const { text, links } = toMarkdown('<a href="/x">A</a> and <a href="/x">B</a>');
  assert.equal(links.length, 1);
  assert.match(text, /\[A\]\[1\].*\[B\]\[1\]/);
});

test('anchors and javascript hrefs keep their text but earn no index', () => {
  const { text, links } = toMarkdown('<a href="#top">Top</a><a href="javascript:void(0)">Go</a>');
  assert.equal(links.length, 0);
  assert.equal(text.includes('Top'), true);
  assert.equal(text.includes('Go'), true);
});

test('a link with no text is dropped as navigation furniture', () => {
  const { links } = toMarkdown('<a href="/icon"><img src="i.png"></a>');
  assert.deepEqual(links, []);
});

test('list items become bullets', () => {
  const { text } = toMarkdown('<ul><li>one</li><li>two</li></ul>');
  assert.match(text, /- one/);
  assert.match(text, /- two/);
});

test('entities are decoded, including numeric ones', () => {
  assert.equal(decodeEntities('a &amp; b &lt;c&gt; &#65; &#x42;'), 'a & b <c> A B');
});

test('a nonsense entity is left as written rather than becoming a wrong character', () => {
  assert.equal(decodeEntities('&notareal; &#999999999;'), '&notareal; &#999999999;');
});

test('blank line runs are collapsed, which HTML produces in quantity', () => {
  const { text } = toMarkdown('<div></div><div></div><p>a</p><div></div><div></div><p>b</p>');
  assert.equal(text.includes('\n\n\n'), false);
});

// --- rendering ---------------------------------------------------------------

test('relative links are resolved against the page they came from', () => {
  const out = renderMarkdown('<a href="news">N</a>', { baseUrl: 'https://news.ycombinator.com/' });
  assert.match(out, /\[1\]: https:\/\/news\.ycombinator\.com\/news/);
});

test('a link URL refuses to resolve is left as written', () => {
  assert.equal(absolute('mailto:a@b.test', 'https://x.test/'), 'mailto:a@b.test');
});

test('the body gives way to the budget, never the link table', () => {
  // A clipped body with a complete link table is still usable; the reverse is
  // not, since the indices in the text would point at nothing.
  const html = `<p>${'x'.repeat(5000)}</p><a href="https://a.test/one">One</a>`;
  const out = renderMarkdown(html, { maxChars: 200 });
  assert.match(out, /\[1\]: https:\/\/a\.test\/one/);
  assert.match(out, /more characters/);
  assert.ok(out.length < 400, `got ${out.length}`);
});

test('links past the cap are counted rather than silently dropped', () => {
  const html = Array.from({ length: 5 }, (_, i) => `<a href="/l${i}">L${i}</a>`).join('');
  const out = renderMarkdown(html, { maxLinks: 2 });
  assert.match(out, /3 more links not listed/);
});

test('JSON is passed through, not mangled into prose', () => {
  assert.equal(looksLikeHtml('application/json', '{"a":1}'), false);
  assert.equal(looksLikeHtml('text/html; charset=utf-8', '<p>x</p>'), true);
});

test('HTML with no content-type is still recognised by its opening tag', () => {
  assert.equal(looksLikeHtml('', '<!doctype html><html><body>x'), true);
  assert.equal(looksLikeHtml('', 'id,name\n1,a'), false);
});
