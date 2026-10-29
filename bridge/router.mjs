/**
 * Which model runs a turn.
 *
 * Sonnet 5 handles the ordinary case: read a page, post a message, check
 * Linear, answer a question. Opus 5 is reserved for work that is genuinely
 * visual or genuinely deep, where the cost difference buys something.
 *
 * Every turn runs at `high` effort, whichever model. Measured 2026-10-29 on a
 * yes/no turn: `xhigh` took 8 to 9 s to the first reply, almost all thinking;
 * `high`, `medium` and `low` took 3 to 5 s. Effort, not the model, was the cost.
 *
 * Both `--model` and `--effort` are per-invocation, so a thread that starts on
 * Sonnet can escalate for one turn and drop back. The session carries the
 * conversation, not the model choice.
 *
 * Routing is keyword-based on purpose. An LLM classifier would cost a round
 * trip on every message to decide something a word list gets right nearly
 * always, and the cost of being wrong here is one pricier run, not a failure.
 */

export const DEFAULT_MODEL = 'sonnet';
export const DEEP_MODEL = 'opus';
export const EFFORT = 'high';

/**
 * Explicit override, checked first: the user can force either model by opening the
 * message with a bare word. `deep: compare these two dashboards` or
 * `fast: what's my next meeting`.
 */
const FORCE_DEEP = /^\s*(deep|opus|think(\s+hard)?)\s*[:,-]/i;
const FORCE_FAST = /^\s*(fast|quick|sonnet)\s*[:,-]/i;

/**
 * Visual work. A screenshot has to be looked at rather than parsed, and the
 * accessibility snapshot is no help for anything that is about pixels: layout,
 * spacing, colour, whether a design actually reads well.
 */
const VISUAL = [
  'screenshot', 'screen shot', 'look at', 'take a look', 'see if',
  'visual', 'visually', 'design', 'mockup', 'mock up', 'layout',
  'colour', 'color', 'spacing', 'alignment', 'font', 'image', 'photo',
  'chart', 'graph', 'diagram', 'ui', 'ux', 'looks right', 'looks good',
  'render', 'preview', 'thumbnail', 'logo', 'banner',
  // Drawing and whiteboard tools. Added 2026-08-25 after "can you draft on how
  // you works in excalidraw?" routed to Sonnet: these are <canvas> apps, so the
  // accessibility snapshot is empty and every step has to be done from
  // screenshots. That is the most visual work there is.
  'excalidraw', 'draw', 'drawing', 'sketch', 'whiteboard', 'wireframe',
  'flowchart', 'figma', 'miro', 'illustrate', 'annotate',
];

/**
 * Deep work: open-ended investigation, cross-referencing, or judgement, as
 * opposed to fetching a fact or sending a message.
 */
const DEEP = [
  'investigate', 'analyse', 'analyze', 'analysis', 'audit', 'research',
  'compare', 'comparison', 'why is', 'why did', 'why does', 'figure out',
  'root cause', 'debug', 'diagnose', 'thorough', 'in depth', 'in-depth',
  'deep dive', 'deep-dive', 'strategy', 'plan out', 'review the',
  'walk through', 'walkthrough', 'summarise my inbox', 'summarize my inbox',
  'across all', 'every channel', 'trace',
];

/**
 * Match on whole words, not substrings.
 *
 * A bare `includes()` made the two-letter tokens catastrophic: "ui" matched
 * inside quick, build, guide, require and suit, so "quick check: what's on my
 * calendar tomorrow" routed to Opus as a visual task. Measured in production
 * 2026-08-27, and invisible because the wrong model still answers correctly, it
 * just costs more and runs slower.
 *
 * Multi-word phrases still work: the boundary applies at each end of the phrase,
 * not between its words.
 */
function matches(haystack, needles) {
  for (const n of needles) {
    const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\b${escaped}\\b`, 'i').test(haystack)) return n;
  }
  return null;
}

/**
 * Choose a model for one turn.
 *
 * @param {string} text  what the user actually typed, mention already stripped
 * @returns {{model: string, effort: string, reason: string}}
 */
export function pickModel(text) {
  const raw = String(text ?? '');
  const lower = raw.toLowerCase();

  if (FORCE_FAST.test(raw)) {
    return { model: DEFAULT_MODEL, effort: EFFORT, reason: 'forced fast' };
  }
  if (FORCE_DEEP.test(raw)) {
    return { model: DEEP_MODEL, effort: EFFORT, reason: 'forced deep' };
  }

  const visual = matches(lower, VISUAL);
  if (visual) {
    return { model: DEEP_MODEL, effort: EFFORT, reason: `visual: "${visual}"` };
  }

  const deep = matches(lower, DEEP);
  if (deep) {
    return { model: DEEP_MODEL, effort: EFFORT, reason: `deep: "${deep}"` };
  }

  return { model: DEFAULT_MODEL, effort: EFFORT, reason: 'default' };
}

/**
 * Strip a leading `deep:` / `fast:` marker so the model never sees the routing
 * instruction as part of the task.
 */
export function stripDirective(text) {
  return String(text ?? '').replace(FORCE_DEEP, '').replace(FORCE_FAST, '').trimStart();
}
