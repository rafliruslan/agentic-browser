export const MAX_OUTPUT = 3500;

/**
 * Slack appends this to messages sent through some apps, INLINE with a space
 * rather than on a new line: "stop" is delivered as
 * "stop *Sent using* <@U0A8...>".
 *
 * Both isStopPhrase and parseInterrupt match the whole message, so without
 * stripping it, unfollowing a thread and stopping a run both silently did
 * nothing for anyone using that app. Anchored to the end, so prose that
 * happens to discuss sending is untouched.
 */
const TRAILING_ATTRIBUTION = /\s*\*Sent using\*\s*<@[^>]+>\s*$/i;

/** A message without the attribution Slack may have appended to it. */
export function stripAttribution(text) {
  return String(text ?? '').replace(TRAILING_ATTRIBUTION, '');
}

const TRUNCATION_MARKER = '\n… (truncated)';

/**
 * The browser is not reachable, as opposed to the request being bad.
 *
 * Rewritten for Brave-over-CDP. An earlier list watched for a different daemon
 * ("... is not running", "extension not connected"); those strings can never
 * appear on Linux, and leaving them would have meant a real CDP outage fell
 * through to the generic failure text instead of a message that says what to do.
 */
const NOT_RUNNING_HINTS = [
  'econnrefused',
  'browser is not running',
  'no browser profile',
  'browser has been closed',
  'target page, context or browser has been closed',
  'failed to connect to the browser',
  'connect econnrefused 127.0.0.1:9222',
  'websocket error',
];

/**
 * A session whose browser binding has broken. Every tab it opens fails, and it
 * stays broken for the life of that session, so resuming it is pointless.
 */
const DEAD_SESSION_HINTS = [
  'belongs to a different browser profile',
  'browser profile mismatch',
  'session is not attached',
];

/**
 * A harness can evict old sessions from its registry while leaving the
 * log directory on disk: measured at 442 directories against 152 registered.
 * Resuming an evicted id fails, and it will fail forever, so the thread has to
 * be released and the work retried in a fresh session.
 */
const MISSING_SESSION_RE = /session not found/i;

export function isMissingSession(text) {
  return MISSING_SESSION_RE.test(String(text ?? ''));
}

/** True when the failure is the session itself, not the request. */
export function isDeadSession(text) {
  const blob = String(text ?? '').toLowerCase();
  return DEAD_SESSION_HINTS.some((hint) => blob.includes(hint)) || isMissingSession(blob);
}

/** A run killed by the network rather than by anything in the request. */
const NETWORK_HINTS = [
  'fetch failed',
  'enotfound',
  'etimedout',
  'econnreset',
  'network error',
  'socket hang up',
  'getaddrinfo',
];

/**
 * Raw agent stdout when a run dies mid-flight: internal reasoning and tool
 * invocations, not an answer. Showing it is worse than showing nothing.
 */
function looksLikeRawTrace(text) {
  return /^\s*Thinking:/m.test(text) || /^\s*\w+\((?:objective|code|queries|id|path):/m.test(text);
}

/**
 * Remove the bot mention from an app_mention text and return the bare prompt.
 * Collapses runs of spaces and tabs but preserves newlines, so multi-line
 * prompts survive intact.
 */
export function parseMention(text, botUserId) {
  if (typeof text !== 'string') return '';
  const pattern = botUserId ? new RegExp(`<@${botUserId}>`, 'g') : /<@[A-Z0-9]+>/g;
  return text.replace(pattern, ' ').replace(/[ \t]+/g, ' ').trim();
}

/** Cap text at `limit` characters, appending a marker when it was cut. */
export function truncateOutput(text, limit = MAX_OUTPUT) {
  const value = String(text ?? '');
  if (value.length <= limit) return value;
  return value.slice(0, limit - TRUNCATION_MARKER.length).trimEnd() + TRUNCATION_MARKER;
}

/**
 * Normalise Markdown habits into Slack mrkdwn.
 *
 * The persona can ask for Slack mrkdwn, and the agent mostly complies, but "mostly"
 * is not good enough for something that renders as visible garbage. Observed in
 * a live thread: `**bold**` came through as literal asterisks and a Markdown
 * image tag pointed at a local file path. This runs on every reply so the
 * rendering does not depend on the model remembering.
 *
 * Note `&amp;`, `&lt;` and `&gt;` are left alone: Slack requires those escaped
 * and renders them correctly, so "fixing" them would break the output.
 */
export function toSlackText(text) {
  let out = String(text ?? '');

  // Image tags cannot render in Slack, and a local path leaks the filesystem.
  out = out.replace(/!\[[^\]]*\]\([^)]*\)/g, '');

  // Markdown tables render as literal pipes and dashes in Slack, which has no
  // table support. Keep the data, drop the separator row, and fence it so it
  // lands in a monospaced block where the columns still line up.
  out = out.replace(/(?:^[ \t]*\|.*\|[ \t]*\n?){2,}/gm, (block) => {
    const rows = block
      .replace(/\n+$/, '')
      .split('\n')
      .filter((line) => !/^[ \t]*\|[\s:|-]+\|[ \t]*$/.test(line));
    if (rows.length < 2) return block;
    return '```\n' + rows.join('\n') + '\n```\n';
  });

  // Markdown links become Slack's <url|label> form.
  out = out.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<$2|$1>');

  // Headings do not exist in Slack; a bold line is the closest thing.
  out = out.replace(/^\s{0,3}#{1,6}\s+(.+?)\s*$/gm, '*$1*');

  // Slack bold is one asterisk. Doubles show up as literal characters.
  out = out.replace(/\*\*([^*\n]+?)\*\*/g, '*$1*');

  // Slack does not turn a list marker into a bullet, it leaves the hyphen
  // sitting there. Only the literal character renders as one.
  out = out.replace(/^(\s*)[-*+][ \t]+(?=\S)/gm, '$1• ');

  // Slack auto-links a bare domain, and when one sits inside bold the asterisks
  // get swallowed into the link: `*example.com:*` posts as
  // `<http://example.com:*|example.com:*>`. Backticks suppress auto-linking, so
  // a domain inside a bold span moves into a code span and the bold is dropped.
  // Scoped to bold spans deliberately: rewriting every domain everywhere would
  // catch things like file names and version strings.
  out = out.replace(/\*([^*\n]+)\*/g, (match, inner) => {
    if (!/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b/i.test(inner)) return match;
    if (inner.includes('`') || inner.includes('<')) return match;
    return inner.replace(/\b([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})\b/gi, '`$1`');
  });

  // Em dashes may be banned in the user's writing, and the agent still reaches for
  // them. A dash between two numbers is a range and becomes a hyphen; anywhere
  // else it is doing the job of a comma, so it becomes one.
  // These two lines ARE the stripper, so they have to contain the character
  // the hook rejects. The marker is what lets them through it.
  out = out.replace(/(\d)\s*[—–]\s*(\d)/g, '$1-$2'); // em-dash-ok
  out = out.replace(/\s*[—–]\s*/g, ', '); // em-dash-ok

  // Tidy the gaps left by anything removed above.
  return out.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Turn a runner result into the message body posted back to Slack.
 *
 * Failure text can arrive in either stream: an agent CLI may print its own
 * errors to stdout while exiting 0 (see docs/probe-notes.md), so both fields
 * are consulted rather than assuming stderr carries the diagnosis.
 */
export function formatResult(result) {
  if (result.timedOut) {
    // Work may continue after the CLI is killed, so this is "not back yet"
    // rather than "failed". The text below is whatever was said by then.
    const partial = truncateOutput(toSlackText(result.output));
    const head = '⏱ Ran past the time limit. It may still be finishing in the browser.';
    return partial ? `${head}\n\n${partial}` : head;
  }

  if (!result.ok) {
    const blob = `${result.error} ${result.output}`.toLowerCase();
    if (NOT_RUNNING_HINTS.some((hint) => blob.includes(hint))) {
      return "The browser isn't running, so there is nothing to work in. Open it and ask again.";
    }
    if (NETWORK_HINTS.some((hint) => blob.includes(hint))) {
      return '🌐 Lost the network mid-run, so that one died before it finished. Ask me again.';
    }

    const body = toSlackText(result.error || result.output || '');
    // Raw reasoning and tool calls are noise. Say what happened instead.
    if (!body || looksLikeRawTrace(body)) {
      return '❌ That run died before it finished, and it left nothing readable behind. Ask me again.';
    }
    return `❌ Failed.\n\n${truncateOutput(body)}`;
  }

  // Normalise before truncating, since rewriting changes the length.
  return truncateOutput(toSlackText(result.output) || '(no output)');
}
