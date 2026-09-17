/**
 * HTML to compact markdown, for pages the agent reads rather than clicks.
 *
 * `fetch` handed back raw HTML clipped at 12000 characters, which on a real
 * page is mostly markup and a truncation in the middle of a tag. Measured on
 * Hacker News: 34KB of HTML carries 4.2KB of text. A Gmail thread we fetched
 * earlier came back at 771KB.
 *
 * Borrowed from Aside's site skills, which return thread bodies as markdown by
 * default and footnote the links rather than inlining them: a URL costs 40-100
 * characters every time it appears, and the same href is usually repeated.
 * The index also gives the agent something short to quote back when it wants
 * one, instead of copying a long URL into its next call.
 *
 * Deliberately string-only, with no DOM. It has to work on a response body,
 * which is text, and it stays testable without a browser.
 */

/** Blocks whose content is never worth reading. */
const DROP = /<(script|style|noscript|template|svg|head)\b[^>]*>[\s\S]*?<\/\1>/gi;

/** Elements that should start a new line. */
const BLOCK = /<\/?(p|div|section|article|header|footer|main|aside|nav|ul|ol|table|tr|blockquote|pre|form|hr)\b[^>]*>/gi;

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'",
  mdash: '-', ndash: '-', hellip: '…', rsquo: '’', lsquo: '‘',
  ldquo: '"', rdquo: '"', times: '×', middot: '·',
};

export function decodeEntities(s) {
  return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, name) => {
    if (Object.prototype.hasOwnProperty.call(ENTITIES, name)) return ENTITIES[name];
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X'
        ? parseInt(name.slice(2), 16)
        : parseInt(name.slice(1), 10);
      // An out-of-range or unparsable reference is left as written rather than
      // turned into a replacement character that reads like real content.
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return whole;
  });
}

/**
 * Convert one HTML document to markdown.
 *
 * @returns {{text: string, links: string[], chars: number}}
 *   `links` is in index order, so `[3]` in the text is `links[2]`.
 */
export function toMarkdown(html) {
  let s = String(html || '');

  s = s.replace(DROP, ' ');

  // Headings first: they carry the shape of the page, and doing them before
  // the generic block pass keeps their level.
  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, lvl, inner) => `\n\n${'#'.repeat(Number(lvl))} ${inner}\n\n`);

  // Links become [text][n] with the href footnoted once each. The same href
  // seen twice keeps one index rather than paying for it again.
  const links = [];
  const indexOf = new Map();
  s = s.replace(/<a\b[^>]*?href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi,
    (whole, _q, dq, sq, bare, inner) => {
      const href = (dq ?? sq ?? bare ?? '').trim();
      const text = inner.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      // A link with no text is navigation furniture; an anchor or a javascript:
      // handler goes nowhere worth recording.
      if (!href || !text || /^(#|javascript:)/i.test(href)) return text;
      let i = indexOf.get(href);
      if (i === undefined) {
        links.push(href);
        i = links.length;
        indexOf.set(href, i);
      }
      return `[${text}][${i}]`;
    });

  s = s.replace(/<li\b[^>]*>/gi, '\n- ');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(td|th)>/gi, ' | ');
  s = s.replace(BLOCK, '\n');

  // Whatever tags remain carry no structure worth keeping.
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);

  // Collapse runs of spaces without eating the line structure just built, then
  // runs of blank lines, which HTML produces in quantity.
  s = s.replace(/[^\S\n]+/g, ' ');
  s = s.replace(/ *\n */g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  s = s.trim();

  return { text: s, links, chars: s.length };
}

/**
 * The markdown plus its link footnotes, clipped to a budget.
 *
 * The footnotes are what the indices in the text refer to, so they are kept
 * whole and the body is what gives way; a clipped body with a complete link
 * table is still usable, the reverse is not.
 */
export function renderMarkdown(html, { maxChars = 12000, maxLinks = 60, baseUrl = null } = {}) {
  const { text, links } = toMarkdown(html);
  // Resolved against the page they came from, because "news" is not something
  // the agent can pass to fetch and a relative href is the common case.
  const kept = links.slice(0, maxLinks).map((href) => absolute(href, baseUrl));
  const footer = kept.length
    ? `\n\n${kept.map((href, i) => `[${i + 1}]: ${href}`).join('\n')}` +
      (links.length > maxLinks ? `\n(${links.length - maxLinks} more links not listed)` : '')
    : '';

  const budget = Math.max(0, maxChars - footer.length);
  const body = text.length > budget
    ? `${text.slice(0, budget)}\n… [${text.length - budget} more characters]`
    : text;

  return body + footer;
}

/** A link as something fetch could actually be given. */
export function absolute(href, baseUrl) {
  if (!baseUrl) return href;
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    // mailto:, tel:, and anything else URL refuses to resolve stay as written.
    return href;
  }
}

/** Whether a response body should be read as HTML at all. */
export function looksLikeHtml(contentType, body) {
  if (/\b(json|javascript|css|csv|plain)\b/i.test(contentType || '')) return false;
  if (/\bhtml\b/i.test(contentType || '')) return true;
  return /^\s*(<!doctype html|<html\b)/i.test(String(body || '').slice(0, 200));
}
