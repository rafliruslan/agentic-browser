/**
 * The policy and formatting half of the `fetch` tool. No browser here, so it
 * can be tested.
 *
 * Why this tool exists: Aside's site skills say "don't have to open a browser
 * tab" for Gmail, Docs, Sheets and Notion. That is the real gap against a
 * DOM-driving agent, and it is not that Aside clicks better - it is that it
 * often does not click at all. It uses the logged-in session as an HTTP client.
 * A Google Calendar out-of-office event took ~15 tool calls through the DOM;
 * the same thing is one request to an endpoint the page already calls.
 *
 * Why it is a separate TOOL and not an `act` op: denial is per tool. An op
 * inside `act` could only be removed by removing all of `act`, and the reason
 * `act` has a closed enum at all is that a dangerous capability should be
 * removable - which is how `browser_run_code_unsafe` came to be denied here.
 * One `--deniedTools mcp__browser-repl__fetch` turns this off and leaves the rest.
 *
 * Why same-origin, enforced here rather than left to the browser: the request
 * runs inside a page that is already signed in, so it carries that session's
 * cookies. Without the origin check this stops being "read the Gmail you are
 * logged into" and becomes "make authenticated requests to anywhere, from
 * inside the user's browser". CORS would refuse most cross-origin calls anyway,
 * but a policy that depends on the target site's headers is not a policy.
 */

import { renderMarkdown, looksLikeHtml } from './markdown.mjs';

const HTTP = new Set(['http:', 'https:']);
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Headers worth showing back. An allowlist, not a denylist: `set-cookie` is the
 * obvious thing to keep out of a transcript, but it is not the only one, and a
 * denylist has to be right about every header a site invents.
 */
const KEEP_HEADERS = ['content-type', 'content-length', 'date', 'location', 'x-goog-status', 'retry-after'];

/** True for methods that can change something on the far side. */
export function isWrite(method) {
  return WRITE_METHODS.has(String(method || 'GET').toUpperCase());
}

/**
 * Resolve `target` against the page's origin, refusing anything that would
 * leave it.
 *
 * @returns {{url: string, origin: string}}
 */
export function resolveTarget(pageUrl, target) {
  let page;
  try {
    page = new URL(String(pageUrl));
  } catch {
    throw new Error(`The page has no usable origin to fetch from (${pageUrl}). Navigate it somewhere first.`);
  }
  if (!HTTP.has(page.protocol)) {
    throw new Error(`The page has no usable origin to fetch from (${pageUrl}). Navigate it somewhere first.`);
  }

  let url;
  try {
    url = new URL(String(target), page.origin);
  } catch {
    throw new Error(`Not a usable url: ${JSON.stringify(target)}`);
  }
  if (!HTTP.has(url.protocol)) {
    throw new Error(`Only http and https can be fetched, not ${url.protocol}`);
  }
  if (url.origin !== page.origin) {
    throw new Error(
      `Cross-origin fetch refused: the page is ${page.origin}, the request is ${url.origin}. ` +
        `Open a tab on ${url.origin} and fetch from there, so the request carries that site's own session.`,
    );
  }
  return { url: url.href, origin: page.origin };
}

function clip(text, maxChars) {
  const s = String(text ?? '');
  if (s.length <= maxChars) return s;
  return `${s.slice(0, maxChars)}\n… truncated at ${maxChars} of ${s.length} chars`;
}

/**
 * One response, rendered for the agent.
 *
 * An HTML body is converted to markdown rather than clipped as source. Raw
 * HTML spends the whole budget on markup and then truncates mid-tag: measured
 * on the Hacker News front page, 34KB of HTML is 5.6KB of markdown, and the
 * page arrives whole instead of cut off a third of the way in. Anything that
 * is not HTML - JSON above all, which is what most of these calls fetch - is
 * passed through untouched, since it is already the shape the agent wants.
 */
export function renderResponse(res, { maxChars = 12000, markdown = true } = {}) {
  if (res?.error) return `fetch failed: ${res.error}`;

  const headers = res.headers || {};
  const shown = KEEP_HEADERS.filter((h) => headers[h] !== undefined)
    .map((h) => `${h}: ${headers[h]}`)
    .join('\n');

  const html = markdown && looksLikeHtml(headers['content-type'], res.body);
  const body = html
    ? renderMarkdown(res.body, { maxChars, baseUrl: res.url })
    : clip(res.body, maxChars);

  return [
    `${res.status} ${res.statusText || ''}  ${res.url}`.replace(/\s+/g, ' ').trim(),
    shown,
    html ? '(html read as markdown; links are footnoted by index)' : '',
    '',
    body,
  ]
    .filter((part, i) => part !== '' || i === 3)
    .join('\n');
}
