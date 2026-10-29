/**
 * Show progress on the user's own message, rather than only in a reply.
 *
 * The placeholder reply says "running" and later becomes the answer, which is
 * necessary but invisible until you open the thread. A reaction on the message
 * you just sent is visible from the channel list, so a busy channel still shows
 * at a glance what was picked up, what finished, and what failed.
 *
 * Slack has no typing indicator for ordinary bots. The nearest real thing is
 * `assistant.threads.setStatus`, which needs the app configured as an AI
 * assistant and only applies inside assistant threads. It is attempted here and
 * ignored when unavailable, so enabling the Agents feature later lights it up
 * with no code change.
 *
 * Every call is best effort. A missing `reactions:write` scope must degrade to
 * a bridge without reactions, never to a bridge that stops answering.
 */

/** Picked up and working. */
export const WORKING = 'eyes';
/** Finished, and the request is done. */
export const DONE = 'white_check_mark';
/** Replied, but only part of the request is done. */
export const PARTIAL = 'warning';
/** Replied, and is waiting for an answer before it can go on. */
export const QUESTION = 'question';
/** Failed or blocked: the request is not done. */
export const FAILED = 'x';
/** Killed at the run limit. Matches the stopwatch that opens the reply. */
export const TIMED_OUT = 'stopwatch';

/** Slack shortcode names, no colons. Kept together so tests can assert them. */
export const ALL = [WORKING, DONE, PARTIAL, QUESTION, FAILED, TIMED_OUT];

/**
 * A reply used to get a green tick whenever it was posted, whatever it said, so
 * "I could not do that" and "which one first?" both read as done. The agent now
 * ends its reply with a line saying how it went, and the bridge turns that into
 * the reaction. The line is stripped before anything is posted.
 */
const STATUS_LINE = /\s*\[status:[ \t]*(done|partial|blocked|question)[ \t]*\][ \t]*$/i;
const ANY_STATUS_LINE = /[ \t]*\[status:[ \t]*(?:done|partial|blocked|question)[ \t]*\]/gi;

/**
 * Take the status line off a reply.
 * @returns {{ text: string, outcome: 'done'|'partial'|'blocked'|'question'|null }}
 */
export function splitOutcome(text) {
  const s = String(text ?? '');
  const m = s.match(STATUS_LINE);
  // Anywhere else it is stripped too, so a line the agent put in the wrong place
  // never reaches Slack. It just counts for nothing.
  const clean = (t) => t.replace(ANY_STATUS_LINE, '').replace(/\n{3,}/g, '\n\n').trim();
  if (!m) return { text: clean(s), outcome: null };
  return { text: clean(s.slice(0, m.index)), outcome: m[1].toLowerCase() };
}

/**
 * Pick the reaction for a posted reply.
 *
 * `ok` is the bridge's own verdict (the run did not fail or time out). The
 * agent's word can only make that worse, never better: a run that failed is
 * never shown as done. With no status line, a reply whose last line is a
 * question is taken as waiting for an answer, and anything else as done.
 *
 * `timedOut` is a run the bridge killed at its limit. Its own marker, the same
 * stopwatch the reply opens with, so it reads as neither done nor failed.
 */
export function reactionFor({ ok, outcome, text, timedOut } = {}) {
  if (timedOut) return TIMED_OUT;
  if (!ok) return FAILED;
  if (outcome === 'blocked') return FAILED;
  if (outcome === 'partial') return PARTIAL;
  if (outcome === 'question') return QUESTION;
  if (outcome === 'done') return DONE;
  const last = String(text ?? '').trim().split('\n').pop().trim();
  return /\?["')\]]*$/.test(last) ? QUESTION : DONE;
}

/**
 * Add a reaction, swallowing the errors that are not worth failing a run over.
 * `already_reacted` is success from our point of view.
 */
export async function react(client, { channel, ts, name, logger } = {}) {
  if (!client || !channel || !ts || !name) return false;
  try {
    await client.reactions.add({ channel, timestamp: ts, name });
    return true;
  } catch (err) {
    const code = err?.data?.error || err?.message || 'unknown';
    if (code === 'already_reacted') return true;
    // missing_scope is the expected state until reactions:write is granted.
    if (code !== 'missing_scope') logger?.warn?.(`[status] reaction ${name} failed: ${code}`);
    return false;
  }
}

/** Remove one of ours. `no_reaction` means it was never there, which is fine. */
export async function unreact(client, { channel, ts, name, logger } = {}) {
  if (!client || !channel || !ts || !name) return false;
  try {
    await client.reactions.remove({ channel, timestamp: ts, name });
    return true;
  } catch (err) {
    const code = err?.data?.error || err?.message || 'unknown';
    if (code === 'no_reaction' || code === 'missing_scope') return false;
    logger?.warn?.(`[status] unreact ${name} failed: ${code}`);
    return false;
  }
}

/**
 * Move from the working marker to a final one, in that order: the old marker
 * goes first so the message is never briefly showing both.
 */
export async function settle(client, { channel, ts, ok, name, logger } = {}) {
  await unreact(client, { channel, ts, name: WORKING, logger });
  return react(client, { channel, ts, name: name || (ok ? DONE : FAILED), logger });
}

/**
 * Assistant-thread status line, the closest Slack has to "is typing".
 * Silently does nothing unless the app is an AI assistant.
 */
export async function setStatus(client, { channel, threadTs, status, logger } = {}) {
  if (!client?.assistant?.threads?.setStatus || !channel || !threadTs) return false;
  try {
    await client.assistant.threads.setStatus({
      channel_id: channel,
      thread_ts: threadTs,
      status: status || '',
    });
    return true;
  } catch (err) {
    const code = err?.data?.error || err?.message || 'unknown';
    // Expected whenever this is not an assistant thread. Not worth a log line.
    const expected = ['missing_scope', 'not_allowed_token_type', 'invalid_thread', 'channel_not_found'];
    if (!expected.includes(code)) logger?.warn?.(`[status] setStatus failed: ${code}`);
    return false;
  }
}
