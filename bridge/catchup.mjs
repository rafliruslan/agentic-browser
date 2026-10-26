/**
 * Answer mentions that never arrived.
 *
 * Slack delivers an event once, to whatever socket is open at that moment. If
 * there is none, because the Mac is asleep or the socket is half-dead and has
 * not noticed yet, the event is gone and nothing redelivers it. 2026-10-26
 * 16:59: a mention sent while the lid was shut; the socket came back at 17:00
 * and the mention was never seen. The pong warnings start well before the
 * client admits it is down, so the window opens LOOKBACK_MS before the drop.
 *
 * So after a reconnect, and once at startup, read recent history and answer
 * any mention nobody answered. "Answered" is read from Slack, not memory, so
 * it survives a restart: every handled mention carries the bot's reaction
 * (status.mjs), or failing that has a reply from the bot after it in its
 * thread. Mentions seen live by this process are skipped too, which covers
 * one that is queued but not started.
 *
 * Interrupts are never replayed. A `!stop` that arrives late would end
 * whatever run is going now, which is not the one it was aimed at.
 */

export const LOOKBACK_MS = 10 * 60 * 1000;
export const STARTUP_MS = 2 * 60 * 60 * 1000;
// A thread is found through its parent, and history is filtered by the
// parent's ts, so a reply today in an older thread needs the parent in range.
export const THREAD_MS = 7 * 24 * 60 * 60 * 1000;
const TYPES = 'public_channel,private_channel,mpim';

const toTs = (ms) => (ms / 1000).toFixed(6);
const tsMs = (ts) => Number.parseFloat(ts) * 1000;

/** A message someone wrote that tags the bot. */
export function isMention(msg, botUserId) {
  if (!msg || msg.bot_id || !msg.user || msg.user === botUserId) return false;
  if (msg.subtype && msg.subtype !== 'file_share') return false;
  return typeof msg.text === 'string' && msg.text.includes(`<@${botUserId}>`);
}

/** The bot reacted to it, or wrote in its thread after it. */
export function answered(msg, thread, botUserId) {
  if ((msg.reactions || []).some((r) => (r.users || []).includes(botUserId))) return true;
  return thread.some((m) => m.user === botUserId && tsMs(m.ts) > tsMs(msg.ts));
}

/** Seen-live record, bounded so a long-lived process does not grow it forever. */
export function createSeen(max = 1000) {
  const keys = new Set();
  const key = (channel, ts) => `${channel}:${ts}`;
  return {
    /** True the first time, false after. */
    claim(channel, ts) {
      const k = key(channel, ts);
      if (keys.has(k)) return false;
      keys.add(k);
      if (keys.size > max) keys.delete(keys.values().next().value);
      return true;
    },
    has: (channel, ts) => keys.has(key(channel, ts)),
  };
}

async function pages(call, field, args, max = 20) {
  const out = [];
  let cursor;
  for (let i = 0; i < max; i++) {
    const r = await call({ ...args, ...(cursor ? { cursor } : {}) });
    out.push(...(r[field] || []));
    cursor = r.response_metadata?.next_cursor;
    if (!cursor) break;
  }
  return out;
}

/**
 * Unanswered mentions of the bot sent between `since` and `until` (ms), oldest
 * first, as `{ channel, ts, thread_ts, user, text, files }`. A channel that
 * fails to read is logged and skipped, not fatal.
 */
export async function findMissed({ client, botUserId, since, until, threadMs = THREAD_MS, log = console }) {
  const inWindow = (m) => tsMs(m.ts) >= since && tsMs(m.ts) <= until;
  const channels = await pages((a) => client.users.conversations(a), 'channels', {
    types: TYPES, exclude_archived: true, limit: 200,
  });
  const found = [];
  for (const ch of channels) {
    try {
      const top = await pages((a) => client.conversations.history(a), 'messages', {
        channel: ch.id, oldest: toTs(since - threadMs), latest: toTs(until), limit: 200,
      }, 5);
      for (const parent of top) {
        let thread = [];
        if (parent.reply_count && parent.latest_reply && tsMs(parent.latest_reply) >= since) {
          thread = await pages((a) => client.conversations.replies(a), 'messages', {
            channel: ch.id, ts: parent.ts, oldest: toTs(since), limit: 200,
          }, 5);
        }
        const candidates = [parent, ...thread.filter((m) => m.ts !== parent.ts)];
        for (const m of candidates) {
          if (!inWindow(m) || !isMention(m, botUserId)) continue;
          if (answered(m, thread, botUserId)) continue;
          found.push({ channel: ch.id, ts: m.ts, thread_ts: m.thread_ts, user: m.user, text: m.text, files: m.files });
        }
      }
    } catch (err) {
      log.warn?.(`[catchup] could not read ${ch.id}: ${err.data?.error || err.message}`);
    }
  }
  return found.sort((a, b) => tsMs(a.ts) - tsMs(b.ts));
}

/** Told to the agent alongside a late mention, so it does not answer as if live. */
export function lateNote(ts) {
  const at = new Date(tsMs(ts)).toISOString().replace(/\.\d+Z$/, 'Z');
  return `This message was sent at ${at} UTC and reached you late, after the connection dropped. Read the thread for anything that changed since.`;
}

/**
 * Run catch-ups one at a time. Each call scans [since, now]; a call made while
 * one is running waits for it, so overlapping reconnects do not race to
 * answer the same mention.
 */
export function createCatchup({ client, botUserId, seen, dispatch, isInterrupt, now = () => Date.now(), log = console }) {
  let chain = Promise.resolve();
  return function catchUp(since, reason) {
    chain = chain.then(async () => {
      const until = now();
      let missed;
      try {
        missed = await findMissed({ client, botUserId, since, until, log });
      } catch (err) {
        log.error?.(`[catchup] ${reason}: scan failed: ${err.data?.error || err.message}`);
        return;
      }
      let answeredNow = 0;
      for (const m of missed) {
        if (seen.has(m.channel, m.ts)) continue;
        if (isInterrupt(m.text)) {
          seen.claim(m.channel, m.ts);
          log.log?.(`[catchup] ${m.ts} is an interrupt; not replaying it late`);
          continue;
        }
        if (!seen.claim(m.channel, m.ts)) continue;
        answeredNow += 1;
        log.log?.(`[catchup] ${reason}: answering missed mention ${m.ts}`);
        // Not awaited: dispatch queues a whole run, and the next mention should
        // not wait behind it.
        Promise.resolve(dispatch(m)).catch((err) => log.error?.(`[catchup] ${m.ts} failed: ${err.message}`));
      }
      // Quiet when there is nothing: reconnects happen several times an hour.
      if (missed.length || reason === 'startup') log.log?.(`[catchup] ${reason}: ${missed.length} unanswered, ${answeredNow} picked up`);
    });
    return chain;
  };
}
