/**
 * Turn her mrkdwn reply into Block Kit `rich_text`, so Slack renders real lists.
 *
 * Posting `• item` as plain text puts a literal bullet character in the message.
 * It looks approximately right and is not a list: no hanging indent, no proper
 * wrapping, and it reads as a symbol someone typed. Native lists only exist as
 * `rich_text_list` elements inside a `rich_text` block.
 *
 * `text` is still sent alongside as the notification and fallback string.
 */

/** Bullet lines, either the literal character or a Markdown marker. */
const BULLET_LINE = /^\s*(?:•|[-*+])\s+(.*)$/;

/** Ordered list lines: "1. thing". */
const ORDERED_LINE = /^\s*\d+[.)]\s+(.*)$/;

/**
 * One pass over links, code spans, bold, italic and bare URLs.
 *
 * The bare URL is its own alternative so it is read before the italic rule can
 * see it. Without it `docs.google.com/document/d/1AbC_dEf_gH/edit` lost both
 * underscores and italicised the middle of the ID, and Drive, Linear and Slack
 * links are full of underscores.
 */
const INLINE = /(<[^<>]+>)|(`[^`\n]+`)|(\*[^*\n]+\*)|(_[^_\n]+_)|(https?:\/\/[^\s<>]+)/g;

/**
 * Split the trailing punctuation off a bare URL. A sentence's full stop, comma
 * or closing bracket is not part of the address, but a `)` that balances a `(`
 * inside it is (`.../Foo_(bar)`).
 */
function splitUrl(raw) {
  let url = raw;
  for (;;) {
    const last = url.slice(-1);
    const open = (url.match(/\(/g) || []).length;
    const close = (url.match(/\)/g) || []).length;
    if (/[.,;:!?'"*_\]}]/.test(last) || (last === ')' && close > open)) url = url.slice(0, -1);
    else break;
  }
  return { url, rest: raw.slice(url.length) };
}

/**
 * rich_text carries literal characters, unlike mrkdwn which needs these
 * escaped. Leaving them encoded would render "&amp;" to the reader.
 */
function unescapeSlack(text) {
  return String(text ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Build the element for a `<...>` token: user, channel, link, or plain text. */
function angleToken(token) {
  const inner = token.slice(1, -1);
  const bar = inner.indexOf('|');
  const head = bar === -1 ? inner : inner.slice(0, bar);
  const label = bar === -1 ? '' : inner.slice(bar + 1);

  if (/^@[UW][A-Z0-9]+$/.test(head)) return { type: 'user', user_id: head.slice(1) };
  if (/^#[C][A-Z0-9]+$/.test(head)) return { type: 'channel', channel_id: head.slice(1) };
  if (/^!/.test(head)) return { type: 'broadcast', range: head.slice(1) };
  if (/^https?:\/\//i.test(head) || /^mailto:/i.test(head)) {
    // A link's url is a literal field, so `&amp;` from mrkdwn becomes `&` again.
    const url = unescapeSlack(head);
    return label ? { type: 'link', url, text: unescapeSlack(label) } : { type: 'link', url };
  }
  return { type: 'text', text: unescapeSlack(token) };
}

/** A text element, carrying style only when there is some. */
function textElement(text, style, literal = false) {
  const element = { type: 'text', text: literal ? text : unescapeSlack(text) };
  if (Object.keys(style).length > 0) element.style = { ...style };
  return element;
}

/**
 * Parse one line of mrkdwn into rich_text inline elements.
 *
 * Recurses through bold and italic so nested formatting survives. The agent writes
 * things like `*`PE-779`:*`, and a flat parser treats the inner backticks as
 * literal characters inside the bold run, which renders them visibly.
 */
export function parseInline(line, style = {}) {
  const source = String(line ?? '');
  const out = [];
  let cursor = 0;

  for (const match of source.matchAll(INLINE)) {
    if (match.index > cursor) {
      out.push(textElement(source.slice(cursor, match.index), style));
    }
    const token = match[0];
    if (match[1]) out.push(angleToken(token));
    // Code contents are literal: never unescaped, never re-parsed.
    else if (match[2]) out.push(textElement(token.slice(1, -1), { ...style, code: true }, true));
    else if (match[3]) out.push(...parseInline(token.slice(1, -1), { ...style, bold: true }));
    else if (match[4]) out.push(...parseInline(token.slice(1, -1), { ...style, italic: true }));
    else if (match[5]) {
      // A bare URL becomes a real link element: a plain text element is not
      // clickable in rich_text. Whatever punctuation followed it stays text.
      const { url, rest } = splitUrl(token);
      out.push(Object.keys(style).length > 0 ? { type: 'link', url, style: { ...style } } : { type: 'link', url });
      if (rest) out.push(textElement(rest, style));
    }
    cursor = match.index + token.length;
  }

  if (cursor < source.length) out.push(textElement(source.slice(cursor), style));

  // Punctuation split off a URL sits beside the text that follows it; join them.
  const merged = [];
  for (const el of out) {
    const prev = merged[merged.length - 1];
    if (prev && prev.type === 'text' && el.type === 'text' && JSON.stringify(prev.style) === JSON.stringify(el.style)) {
      prev.text += el.text;
    } else merged.push(el);
  }
  return merged.length > 0 ? merged : [textElement('', style)];
}

/**
 * Build Block Kit blocks for a reply. Returns null when there is nothing worth
 * structuring, so the caller can fall back to plain text.
 */
export function buildBlocks(text) {
  const source = String(text ?? '');
  if (!source.trim()) return null;

  const lines = source.split('\n');
  const elements = [];
  let paragraph = [];
  let list = null;
  let listStyle = null;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const inline = [];
    paragraph.forEach((line, i) => {
      inline.push(...parseInline(line));
      if (i < paragraph.length - 1) inline.push({ type: 'text', text: '\n' });
    });
    elements.push({ type: 'rich_text_section', elements: inline });
    paragraph = [];
  };

  const flushList = () => {
    if (!list) return;
    elements.push({ type: 'rich_text_list', style: listStyle, indent: 0, elements: list });
    list = null;
    listStyle = null;
  };

  let fenced = null;

  for (const line of lines) {
    // A fenced block is monospaced and keeps its own whitespace, which is how
    // a converted table stays aligned. Nothing inside it is parsed.
    if (/^\s*```/.test(line)) {
      if (fenced) {
        elements.push({
          type: 'rich_text_preformatted',
          elements: [{ type: 'text', text: fenced.join('\n') }],
        });
        fenced = null;
      } else {
        flushList();
        flushParagraph();
        fenced = [];
      }
      continue;
    }
    if (fenced) {
      fenced.push(line);
      continue;
    }

    const bullet = line.match(BULLET_LINE);
    const ordered = bullet ? null : line.match(ORDERED_LINE);

    if (bullet || ordered) {
      const style = bullet ? 'bullet' : 'ordered';
      flushParagraph();
      // A change of list style starts a new list rather than mixing them.
      if (list && listStyle !== style) flushList();
      if (!list) {
        list = [];
        listStyle = style;
      }
      list.push({ type: 'rich_text_section', elements: parseInline((bullet || ordered)[1]) });
      continue;
    }

    flushList();
    if (line.trim() === '') {
      // Blank lines separate paragraphs; they are not content of their own.
      flushParagraph();
      continue;
    }
    paragraph.push(line);
  }

  // An unterminated fence still has content worth showing.
  if (fenced && fenced.length > 0) {
    elements.push({
      type: 'rich_text_preformatted',
      elements: [{ type: 'text', text: fenced.join('\n') }],
    });
  }

  flushList();
  flushParagraph();

  if (elements.length === 0) return null;
  return [{ type: 'rich_text', elements }];
}
