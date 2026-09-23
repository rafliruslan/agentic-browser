import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * The agent's character, prepended to the first prompt of a Slack thread.
 *
 * Only the first prompt: once a thread has a session, the persona is already in
 * that conversation's history, so repeating it every turn burns tokens and makes
 * the agent restate itself.
 *
 * Keep it SHORT, and put in it only what code cannot enforce. An earlier version
 * of this file carried a long list of Slack formatting rules. Those are now
 * applied deterministically on the way out (`text.mjs` normalises mrkdwn,
 * `blocks.mjs` builds native lists), and moving them out of the prompt is what
 * let the persona shrink by 82% without losing anything. The agent ignored them
 * about half the time when they were only instructions.
 *
 * What is worth keeping is the part no function can check:
 * - honesty, so it never reports work it did not do
 * - autonomy, so it acts instead of asking permission
 * - one chat per message, so the session list stays readable
 */

export const PERSONA_PATH =
  process.env.AGENT_PERSONA_PATH || join(homedir(), '.config', 'agentic-browser', 'persona.md');

/**
 * Used when no persona file exists. Deliberately plain: a character is a
 * personal choice, but the honesty and autonomy rules are not optional, so they
 * live here rather than in the user's file where they could be dropped.
 */
const FALLBACK = `You are a capable assistant working on the user's behalf through their browser.

Keep replies SHORT. Answer first. One line if one line will do, five bullets at most.

These are not optional:
- Never invent a result. If something failed, was blocked, or you could not verify it, say so plainly.
- If the user is wrong, say so.
- Act rather than asking permission. Post, reply, update records. Report after. Stop to ask only if the action is irreversible or reaches outside the organisation.
- Do not spawn subagents.
`;

function load() {
  try {
    const text = readFileSync(PERSONA_PATH, 'utf8').trim();
    if (text) return `${text}\n`;
    console.warn(`[persona] ${PERSONA_PATH} is empty, using the neutral fallback`);
    return FALLBACK;
  } catch {
    // Say so. This fallback is competent enough to go unnoticed: after the live
    // install moved from a hardcoded persona to this file, the agent ran without
    // its character for sixteen hours and nobody spotted it, because the replies
    // were still good. A good fallback needs to announce itself.
    console.warn(`[persona] no persona at ${PERSONA_PATH}, using the neutral fallback`);
    return FALLBACK;
  }
}

/** Read once at startup; restart the bridge to pick up an edit. */
export const PERSONA = `${load()}\n---\n\n`;

/**
 * Build the prompt actually handed to the agent.
 *
 * @param {string} prompt      what the user typed, verbatim
 * @param {object} opts
 * @param {string|null} opts.sessionId  existing session, if the thread has one
 * @param {boolean} opts.enabled        persona on or off
 */
export function buildPrompt(prompt, { sessionId = null, enabled = true } = {}) {
  if (!enabled) return prompt;
  if (sessionId) return prompt;
  return PERSONA + prompt;
}
