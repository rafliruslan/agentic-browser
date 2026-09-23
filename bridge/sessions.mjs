import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export const DEFAULT_STATE_PATH = join(
  process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'),
  'agentic-browser',
  'threads.json',
);

/**
 * Claude Code accepts `--session-id <uuid>`, so we do not have to
 * discover an id after the fact by diffing session directories. The id is a
 * pure function of the Slack thread, which means a lost or corrupt store costs
 * nothing: the same thread deterministically resolves to the same session.
 *
 * The store therefore records only whether a session is believed to EXIST yet,
 * which is what decides `--session-id` (first turn) vs `--resume` (later turns)
 * and whether the persona is prepended.
 *
 * Formatted per RFC 4122: version nibble forced to 4, variant to 8, because
 * Claude Code validates the shape and rejects a bare hash.
 */
export function sessionIdFor(threadTs, gen = 0) {
  const h = createHash('sha256').update(`slack-thread:${threadTs}#${gen}`).digest('hex');
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    `4${h.slice(13, 16)}`,
    `8${h.slice(17, 20)}`,
    h.slice(20, 32),
  ].join('-');
}

/**
 * Track which Slack threads already have a Claude Code session.
 * Entries older than maxAgeMs are treated as absent and dropped by prune().
 */
export function createSessionStore({ path, now = () => Date.now(), maxAgeMs = WEEK_MS }) {
  let cache = null;

  async function load() {
    if (cache) return cache;
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8'));
      cache = parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      // Missing or corrupt file: start clean rather than crash the bot.
      cache = {};
    }
    return cache;
  }

  async function persist(data) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(data, null, 2));
  }

  return {
    /** The session id for a thread, or null if there is no live session yet. */
    async get(threadTs) {
      const data = await load();
      const entry = data[threadTs];
      if (!entry) return null;
      if (now() - entry.updatedAt > maxAgeMs) return null;
      return entry.sessionId;
    },

    /**
     * What this thread's NEXT session id will be, live or not.
     *
     * Includes the thread's generation, so a thread whose session was forgotten
     * resolves to a genuinely new id rather than colliding with the dead one.
     */
    async idFor(threadTs) {
      const data = await load();
      return sessionIdFor(threadTs, data[threadTs]?.gen || 0);
    },

    async set(threadTs, sessionId) {
      const data = await load();
      data[threadTs] = { sessionId, gen: data[threadTs]?.gen || 0, updatedAt: now() };
      cache = data;
      await persist(data);
    },

    /**
     * Drop a thread's session so the next message starts a fresh one. Used when
     * Claude Code reports the session is gone, which never recovers by retrying.
     *
     * Because ids are deterministic, a forgotten thread would resolve to the
     * same id again, so record a salt bump to force a genuinely new session.
     */
    async forget(threadTs) {
      const data = await load();
      if (!(threadTs in data)) return false;
      // Keep the row, bump the generation: the id is derived, so deleting
      // outright would hand the thread the same dead session id next time.
      data[threadTs] = {
        sessionId: null,
        gen: (data[threadTs].gen || 0) + 1,
        updatedAt: now(),
      };
      cache = data;
      await persist(data);
      return true;
    },

    /**
     * Retire sessions past maxAgeMs.
     *
     * These become tombstones rather than deletions. Claude Code keeps session
     * logs on disk indefinitely, so a deleted row would let an old thread
     * recompute its original gen-0 id and silently resume a months-old
     * conversation. Keeping the bumped generation makes that impossible.
     * Rows are ~60 bytes; thousands of threads cost a few hundred KB.
     */
    async prune() {
      const data = await load();
      const cutoff = now() - maxAgeMs;
      let removed = 0;
      for (const [key, entry] of Object.entries(data)) {
        if (!entry) {
          delete data[key];
          removed += 1;
        } else if (entry.sessionId && entry.updatedAt < cutoff) {
          data[key] = { sessionId: null, gen: (entry.gen || 0) + 1, updatedAt: entry.updatedAt };
          removed += 1;
        }
      }
      cache = data;
      if (removed > 0) await persist(data);
      return removed;
    },
  };
}
