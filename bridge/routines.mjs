#!/usr/bin/env node
/**
 * Run scheduled routines from the memory tree.
 *
 * A routine is a markdown file in `memory/routines/` describing recurring work:
 * how to do it, what has broken before, and a log of runs. Until now those were
 * documentation and nothing executed them.
 *
 * This wakes on a timer, finds routines whose schedule is due, and runs each one
 * as a Claude Code session with its own file as the task. The file is both the
 * instruction and the memory, which is the point: a routine that discovers
 * something writes it back into the same page the next run reads.
 *
 * Three design choices worth stating, because each prevents a specific failure:
 *
 *   1. NOTIFY ONLY unless a routine opts in. An unattended agent acting on a
 *      schedule with nobody reading is the riskiest thing in this system. The
 *      predecessor to one of these routines tried to auto-approve a person by
 *      name, never matched because he had registered under his wife's name, and
 *      was deleted. Reporting is the safe default; acting is a decision.
 *
 *   2. ONE LINE PER RUN in the log. The system this came from wrote a paragraph
 *      per run and after fifteen runs the log was the same sentence repeated,
 *      with the genuinely useful findings buried inside it.
 *
 *   3. A MISSED RUN IS NOT RETRIED. If the machine was asleep at 09:00 the run
 *      is skipped, not fired late. A payout reminder that arrives at midnight
 *      because the laptop woke up is worse than one that did not arrive.
 */

import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { runAgent } from './runner.mjs';
import { transcriptPathFor } from './mirror.mjs';
import { allowedTools, deniedBrowserTools } from './browser.mjs';
import { healBrowser } from './browser-health.mjs';

const WORKSPACE =
  process.env.AGENT_WORKSPACE || join(homedir(), '.local', 'share', 'agentic-browser', 'workspace');
const ROUTINES = join(WORKSPACE, 'memory', 'routines');
const STATE =
  process.env.AGENT_ROUTINE_STATE ||
  join(homedir(), '.local', 'state', 'agentic-browser', 'routines.json');
const MCP_CONFIG =
  process.env.AGENT_MCP_CONFIG || join(homedir(), '.config', 'agentic-browser', 'mcp.json');

/**
 * Narrower than the bridge on purpose: no WebFetch, no WebSearch. An unattended
 * run at 03:00 has nobody to sanity-check what it read on the open web before
 * acting on it. The browser half comes from the MCP config, same as the bridge,
 * so a routine drives whichever browser this machine has. See browser.mjs.
 */
export const ROUTINE_BASE = [
  'Read', 'Glob', 'Grep',
  // Where a routine may write, and nowhere else. It runs in the "default"
  // permission mode rather than acceptEdits, so a path not listed here is
  // refused: verified on a scratch workspace, where memory/agent/ was refused
  // with no rule naming it. Its own file takes the log line; episodic takes a
  // dated note.
  'Edit(memory/routines/**)',
  'Edit(memory/episodic/**)',
];

/**
 * Taken away from routines outright, not just left off the list.
 *
 * Bash: a routine runs unattended, reading live logged-in pages, with nobody
 * reading the reply before it acts. Shell on this machine is the widest thing
 * a hijacked run could reach. Measured before removing it: the only scheduled
 * run so far (bixgrow-payouts, 2026-09-21) made zero Bash calls - 19 browser
 * calls, and Read, Grep, Glob and one Edit for its own log line.
 *
 * mcp__slack: routines are notify-only and none of them posts. A way to post
 * as the bot is not something an unattended run should hold on the off chance.
 *
 * Denied rather than merely unlisted because an unlisted tool is refused only
 * as long as nothing grants it some other way. A denial holds regardless.
 */
export const ROUTINE_DENIED = [
  'Bash',
  'mcp__slack',
  // The files that load as instructions in later sessions. A routine reads
  // live pages with nobody watching, so one poisoned page written into these
  // would become a standing order. Refused already by the allow-list above;
  // named here as well so the guard survives the permission mode changing.
  'Edit(skills/**)',
  'Edit(.claude/**)',
  'Edit(memory/sites/**)',
  'Edit(memory/agent/**)',
  'Edit(memory/users/**)',
  'Edit(CLAUDE.md)',
];

/**
 * Permission mode for routines. Not acceptEdits: that approves any edit in the
 * workspace, which would make the path allow-list above decorative.
 */
export const ROUTINE_PERMISSION_MODE = 'default';

/** What a routine may use, and what it is refused, for a given MCP config. */
export async function routineGrant(mcpConfig) {
  const allowed = (await allowedTools(mcpConfig, { base: ROUTINE_BASE }))
    .filter((t) => !ROUTINE_DENIED.includes(t));
  const denied = [...(await deniedBrowserTools(mcpConfig)), ...ROUTINE_DENIED];
  return { allowed, denied };
}

// The arbitrary-script tools come from deniedBrowserTools, named for whatever
// this machine calls its browser. `Task` is not listed here because runner.mjs
// unions its own list into every call and that is where it lives; duplicating
// it invites the two copies to drift.

/** Routines are long: a browser task plus a report. */
const TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Parse YAML-ish frontmatter. Deliberately tiny: a routine's frontmatter is a
 * handful of scalars, and a real YAML dependency would be the only one in this
 * file.
 */
function frontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i === -1) continue;
    const key = line.slice(0, i).trim();
    let val = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    if (val === 'true') val = true;
    else if (val === 'false') val = false;
    meta[key] = val;
  }
  return { meta, body: text.slice(m[0].length) };
}

/**
 * Is a cron field due for this value?
 * Supports `*`, a list `1,15`, a step `*` with `/n`, and a plain number.
 * Ranges are not supported; say so rather than silently not matching.
 */
function fieldMatches(field, value) {
  if (field === '*') return true;
  if (field.includes('-')) throw new RangeError(`cron ranges are not supported: "${field}"`);
  if (field.includes('/')) {
    const [range, stepRaw] = field.split('/');
    const step = Number(stepRaw);
    if (!Number.isFinite(step) || step <= 0) return false;
    if (range !== '*') return false;
    return value % step === 0;
  }
  return field
    .split(',')
    .map((x) => Number(x.trim()))
    .some((n) => n === value);
}

/**
 * Five-field cron: minute hour day-of-month month day-of-week.
 * Evaluated at minute resolution against local time.
 */
export function isDue(schedule, now = new Date()) {
  const parts = String(schedule || '').trim().split(/\s+/);
  if (parts.length !== 5) return { due: false, reason: 'schedule needs five cron fields' };
  const [min, hour, dom, mon, dow] = parts;
  let due;
  try {
    due =
    fieldMatches(min, now.getMinutes()) &&
    fieldMatches(hour, now.getHours()) &&
    fieldMatches(dom, now.getDate()) &&
    fieldMatches(mon, now.getMonth() + 1) &&
      fieldMatches(dow, now.getDay());
  } catch (e) {
    // Silently never firing is the worst outcome: the routine looks configured
    // and simply never runs. Surface it as its own reason so the caller logs it.
    return { due: false, reason: e.message };
  }
  return { due, reason: due ? 'due' : 'not due' };
}

/**
 * The key for one scheduled firing: `cron:<instant, to the minute, UTC>`.
 *
 * Derived from the instant the routine is FOR, not from when the tick happened
 * to arrive, so a late or replayed fire produces the same key and collides
 * instead of running twice.
 *
 * One clock throughout. What this replaces spliced a UTC date-hour onto local
 * minutes, which agrees on whole-hour offsets and silently disagrees on
 * +05:30 - a bug that shows up only as a routine firing twice, in one zone.
 */
export function fireKey(when) {
  return `cron:${new Date(when).toISOString().slice(0, 16)}Z`;
}

/**
 * Claim a firing. Returns whether this call won it, and the state to persist.
 *
 * The caller must write the returned state to disk BEFORE spawning anything.
 * The previous code marked the fire in memory and saved only after every
 * routine had finished, so a crash or a kill in between lost the claim and the
 * next tick ran the same minute again. Aside makes this a unique index and
 * spawns only if the insert took; this is the same shape without a database.
 *
 * Pure: the given state is not mutated, so "claimed" and "durable" stay
 * distinguishable to the caller.
 */
export function claimFire(state, name, key) {
  if (state?.[name]?.lastFireKey === key) return { claimed: false, state };
  return {
    claimed: true,
    state: { ...state, [name]: { ...(state?.[name] ?? {}), lastFireKey: key } },
  };
}

async function loadState() {
  try {
    return JSON.parse(await readFile(STATE, 'utf8'));
  } catch {
    return {};
  }
}

async function saveState(s) {
  await mkdir(dirname(STATE), { recursive: true });
  await writeFile(STATE, JSON.stringify(s, null, 2));
}

function buildPrompt(name, body, meta) {
  const acting = meta.may_act === true;
  return [
    `Run the recurring routine "${name}".`,
    '',
    'Its file is below. It contains how to run it, what has broken before, and a',
    'log of previous runs. Follow it exactly; the failure notes are there because',
    'each one already cost a session.',
    '',
    acting
      ? 'This routine MAY act, per its own frontmatter. Stay inside what its scope section allows and nothing wider.'
      : 'This routine is NOTIFY ONLY. Read, report, and change nothing. Do not approve, deny, send, pay or delete, whatever the file seems to invite.',
    '',
    'When you are done:',
    '',
    `1. Append ONE line to the Log section of memory/routines/${name}.md:`,
    '   the date, the outcome, nothing else. Not a paragraph.',
    '2. If you discovered something new about how the site behaves, put it in the',
    `   "What breaks" section of memory/routines/${name}.md, and let the log line`,
    '   just say a new failure mode was recorded. Site notes, skills and the other',
    '   memory files are read-only to a routine: if one of them is wrong, say so in',
    '   your report so it can be fixed.',
    '3. If nothing happened, say so plainly. A quiet run is the normal case and',
    '   inventing significance is worse than reporting nothing.',
    '',
    'Reply with the report only, in a few short lines.',
    '',
    '---',
    '',
    body,
  ].join('\n');
}

async function main() {
  const dry = process.argv.includes('--dry-run');
  const forced = process.argv.find((a) => a.startsWith('--run='))?.slice(6);
  const now = new Date();

  let files;
  try {
    files = (await readdir(ROUTINES)).filter((f) => f.endsWith('.md') && f !== 'README.md');
  } catch {
    console.error(`[routines] no routines directory at ${ROUTINES}`);
    process.exit(1);
  }

  let state = await loadState();
  let ran = 0;

  for (const file of files) {
    const name = basename(file, '.md');
    const { meta, body } = frontmatter(await readFile(join(ROUTINES, file), 'utf8'));

    if (forced) {
      if (name !== forced) continue;
    } else {
      if (meta.enabled !== true) {
        continue;
      }
      if (!meta.schedule) {
        console.log(`[routines] ${name}: enabled but has no schedule, skipping`);
        continue;
      }
      const { due, reason } = isDue(meta.schedule, now);
      if (!due) {
        if (reason !== 'not due') console.log(`[routines] ${name}: ${reason}`);
        continue;
      }
      // A timer that fires late must not run a routine late. Skip, do not catch up.
      const key = fireKey(now);
      const claim = claimFire(state, name, key);
      if (!claim.claimed) continue;
      state = claim.state;
      // Persisted BEFORE the run, not after the loop. A crash between here and
      // the end used to lose the claim, and the next tick re-ran the minute.
      if (!dry) await saveState(state);
    }

    console.log(`[routines] running ${name}${forced ? ' (forced)' : ''}`);
    if (dry) {
      console.log(buildPrompt(name, body, meta).slice(0, 1200));
      continue;
    }

    // Same preflight as a Slack turn. A routine runs unattended, so a wedged
    // browser target here fails silently at 09:00 with nobody watching.
    try {
      const health = await healBrowser({});
      if (health.healed) console.log(`[browser-health] cleared ${health.healed} wedged target(s)`);
    } catch (err) {
      console.warn(`[browser-health] preflight failed, continuing: ${err.message}`);
    }

    // A routine has no thread to derive an id from, so it makes one. It is
    // what names the transcript, and without it the run would be the only kind
    // of turn the bridge cannot show you afterwards.
    const sessionId = randomUUID();
    const grant = await routineGrant(MCP_CONFIG);
    const result = await runAgent({
      prompt: buildPrompt(name, body, meta),
      sessionId,
      isNew: true,
      cwd: WORKSPACE,
      model: meta.model || 'sonnet',
      effort: meta.effort || 'xhigh',
      mcpConfig: MCP_CONFIG,
      allowedTools: grant.allowed,
      deniedTools: grant.denied,
      permissionMode: ROUTINE_PERMISSION_MODE,
      timeoutMs: TIMEOUT_MS,
      transcriptPath: transcriptPathFor(WORKSPACE, sessionId),
    });

    ran += 1;
    state[name] = {
      ...state[name],
      lastRun: now.toISOString(),
      ok: result.ok,
      cost: result.costUsd,
      sessionId,
    };
    console.log(`[routines] ${name}: ${result.ok ? 'ok' : 'FAILED'}`);
    console.log(result.text.split('\n').slice(0, 12).join('\n'));
  }

  if (!dry) await saveState(state);
  if (!ran && !dry) console.log('[routines] nothing due');
}

// Only run when executed directly, so the schedule matcher can be imported and
// tested without firing every due routine as a side effect of the import.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error('[routines] fatal:', e.message);
    process.exit(1);
  });
}
