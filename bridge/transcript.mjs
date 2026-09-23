/**
 * Reading past sessions back.
 *
 * The bridge already resumes a session when a Slack thread continues. What it
 * has never had is a way to LOOK at what it has done: threads.json records only
 * whether a session exists, and the sessions themselves are Claude Code's own
 * JSONL transcripts, which nothing here reads.
 *
 * So this is a reading problem, not a storage one. Nothing new is written. The
 * transcripts are the durable record - threads.json prunes after a week, the
 * transcripts do not - and `claude --resume <id>` already replays any of them.
 *
 * Pure functions over strings and objects, so the awkward parts (a persona
 * prepended to turn one, a half-written line at the end of a live session) are
 * testable without a transcript on disk.
 */
import { basename } from 'node:path';
import { sessionIdFor } from './sessions.mjs';

/**
 * Which file to read each session from, given both sets of transcripts.
 *
 * Ours wins where we have it. Claude Code's copy fills in the sessions that
 * ran before the bridge kept its own, so nothing drops out of the listing the
 * day this ships; each session moves over the next time it runs.
 *
 * A session that straddles the switch reads slightly short for one listing:
 * our copy begins at the turn we started mirroring, so its task line is that
 * turn rather than the thread's opening one. That is the price of not reading
 * a file whose schema we do not control, and it clears itself.
 *
 * @param {{mine: string[], theirs: string[]}} paths  full paths to .jsonl files
 * @returns {Map<string, {path: string, source: 'bridge'|'claude'}>}
 */
export function chooseTranscripts({ mine = [], theirs = [] } = {}) {
  const out = new Map();
  // The runs index lives beside the transcripts and ends in .jsonl too, so a
  // plain glob picked it up and listed it as a session called "index" with no
  // task and no turns.
  const isTranscript = (p) => basename(p, '.jsonl') !== 'index';
  mine = mine.filter(isTranscript);
  theirs = theirs.filter(isTranscript);
  for (const path of theirs) out.set(basename(path, '.jsonl'), { path, source: 'claude' });
  for (const path of mine) out.set(basename(path, '.jsonl'), { path, source: 'bridge' });
  return out;
}

/**
 * The bridge builds one prompt from three parts joined by markdown rules:
 *
 *   <persona>
 *   ---
 *   <what the user actually asked>
 *   ---
 *   You are replying in Slack channel `C...`, thread `...`.
 *
 * Read off a live transcript rather than assumed. The first guess here was
 * "the last paragraph after the persona", which returned the persona's own
 * closing line for all 30 sessions: every row of the listing was identical
 * and told you nothing. Splitting on the rules is what the format actually is.
 */
const RULE = /^\s*---\s*$/m;

/** The text of a message whose content is a string or a list of blocks. */
function textOf(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

/**
 * What the user asked, out of a full prompt. A prompt with no rules is not
 * from the bridge (a hand-run session, say), so it is returned whole.
 */
function taskOf(text) {
  const parts = text.split(RULE).map((p) => p.trim()).filter(Boolean);
  const task = parts.length >= 2 ? parts[1] : text.trim();

  // When the thread already has history the bridge pastes it in, so the task
  // section is mostly other people talking and the listing showed a wall of
  // "Slack thread so far" rows. What the session was actually about is the
  // last thing the user themselves said. Both header variants seen live:
  // with and without ", for context".
  if (!/^Slack thread so far/i.test(task)) return task;

  const mine = [...task.matchAll(/\[the user\]([\s\S]*?)(?=\n\[|$)/g)]
    .map((m) => m[1].trim())
    .filter(Boolean);
  if (mine.length) return mine[mine.length - 1];

  // A thread the user has not spoken in yet: keep the context, drop the header.
  return task.replace(/^Slack thread so far[^\n]*\n+/i, '').trim();
}

/**
 * Where a run was replying, read from the prompt itself.
 *
 * Better than reversing sessionIdFor over threads.json: this survives the
 * store's weekly prune, and it carries the CHANNEL as well as the thread, so
 * the listing can build a real permalink.
 */
export function slackContext(text) {
  const m = /channel\s+`?(C[A-Z0-9]+)`?,\s*thread\s+`?(\d+\.\d+)`?/i.exec(String(text || ''));
  return m ? { channel: m[1], threadTs: m[2] } : null;
}

function oneLine(text, maxTask) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > maxTask ? `${flat.slice(0, maxTask - 1).trimEnd()}…` : flat;
}

/**
 * What one session was, from its transcript.
 *
 * @param {string} id  session id, i.e. the transcript's filename stem
 * @param {string} jsonl  the file's contents
 * @returns {{id: string, task: string|null, turns: number, slack: object|null}}
 */
export function summarise(id, jsonl, { maxTask = 100 } = {}) {
  let task = null;
  let turns = 0;
  let slack = null;

  for (const line of String(jsonl || '').split('\n')) {
    if (!line.trim()) continue;
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      // A live session's last line is often half-written, and a corrupt line
      // anywhere should cost that line, not the summary.
      continue;
    }
    if (m?.type === 'assistant') turns++;
    if (m?.type === 'user') {
      const full = textOf(m.message);
      if (task === null && full.trim()) task = oneLine(taskOf(full), maxTask);
      if (slack === null) slack = slackContext(full);
    }
  }
  return { id, task, turns, slack };
}

/**
 * session id -> Slack thread ts, for the threads the store still remembers.
 *
 * sessionIdFor is a one-way hash, so the map is built forwards: every thread
 * still in threads.json is hashed and the result inverted. Sessions older than
 * the store's week-long prune simply have no entry, which is why the listing
 * shows them without a link rather than hiding them.
 */
export function threadIndex(threads) {
  const out = {};
  for (const [ts, entry] of Object.entries(threads || {})) {
    out[sessionIdFor(ts, entry?.gen ?? 0)] = ts;
  }
  return out;
}

/** An age, because "3d ago" is read faster than a timestamp. */
export function relativeAge(then, now = Date.now()) {
  const s = Math.max(0, Math.round((now - then) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
