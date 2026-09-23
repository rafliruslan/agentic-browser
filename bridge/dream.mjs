#!/usr/bin/env node
/**
 * Consolidate recent sessions into durable memory.
 *
 * The agent already writes memory opportunistically, when something surprises it
 * mid-task. That produces good notes about *sites* and almost nothing about the
 * *person*, because noticing "he corrected me twice about tone" requires looking
 * back across sessions, which nothing was doing.
 *
 * This is that look back. It runs on a timer, reads whatever transcripts are new
 * since the last run, and hands them to a Claude Code session whose only job is
 * to update the memory tree. The judgement stays in the model; this file just
 * decides what it gets to see.
 *
 * What it feeds in is deliberately narrow. A transcript averages 1.5MB, almost
 * all of it tool calls and their results, which are noise for this purpose. What
 * matters is what the user asked, what was reported back, and above all where
 * the user pushed back. A correction is the single highest-signal event
 * available: it is the user stating a preference in the one moment they cared
 * enough to interrupt.
 */

import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { observe, render as renderBrowsing } from './observe.mjs';

/**
 * Claude Code stores a session transcript under ~/.claude/projects/<encoded>,
 * where <encoded> is the absolute workspace path with every `/` and `.` turned
 * into `-`. So /home/u/.local/share/agentic-browser/workspace becomes
 * -home-u--local-share-agentic-browser-workspace: the double dash is the slash and
 * the dot of `/.local` collapsing together.
 */
function encodeProjectDir(abs) {
  return abs.replace(/[/.]/g, '-');
}

const WORKSPACE =
  process.env.AGENT_WORKSPACE || join(homedir(), '.local', 'share', 'agentic-browser', 'workspace');
const TRANSCRIPTS =
  process.env.AGENT_TRANSCRIPTS ||
  join(homedir(), '.claude', 'projects', encodeProjectDir(WORKSPACE));
const STATE =
  process.env.AGENT_DREAM_STATE ||
  join(homedir(), '.local', 'state', 'agentic-browser', 'dream.json');

const exec = promisify(execFile);

/**
 * Commit and push the memory tree if it is a git repo.
 *
 * This runs unattended on a timer, so without it the backup silently goes stale
 * from the first night onwards and you find out when you need it. Entirely
 * optional: if the workspace is not a repo, or has no remote, or nothing
 * changed, this does nothing and says so. A backup failure must never look like
 * a consolidation failure, so every step here is non-fatal.
 */
async function backup(workspace) {
  const git = (...args) => exec('git', ['-C', workspace, ...args]);
  try {
    await git('rev-parse', '--is-inside-work-tree');
  } catch {
    return 'not a git repo, skipped';
  }
  try {
    const { stdout } = await git('status', '--porcelain');
    if (!stdout.trim()) return 'no changes';

    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    await git('add', '-A');
    await git('commit', '-m', `memory: consolidation ${stamp}`);

    try {
      await git('remote', 'get-url', 'origin');
    } catch {
      return 'committed, no remote to push to';
    }

    // A rejected push usually means the same repo was written from another
    // machine, which is normal when memory is backed up from more than one
    // place. Rebase onto whatever arrived and try once more. Observed
    // 2026-08-26: an unrelated export pushed from elsewhere blocked the first
    // automated backup, and a silent --quiet push hid the reason.
    try {
      await git('push', '--quiet', 'origin', 'HEAD');
      return 'committed and pushed';
    } catch (first) {
      try {
        await git('fetch', '--quiet', 'origin');
        await git('-c', 'rebase.autoStash=true', 'rebase', 'origin/HEAD');
        await git('push', '--quiet', 'origin', 'HEAD');
        return 'committed and pushed after rebasing onto remote changes';
      } catch (second) {
        // Leave the rebase un-abandoned rather than guessing; a human should
        // look. The commit is safe locally either way.
        await git('rebase', '--abort').catch(() => {});
        return `committed locally, push rejected: ${String(first.message).split('\n')[0]}`;
      }
    }
  } catch (e) {
    return `backup failed: ${e.message.split('\n')[0]}`;
  }
}

/** Per session, so one enormous thread cannot crowd out five short ones. */
const MAX_TURNS_PER_SESSION = 40;
const MAX_CHARS_PER_TURN = 600;
const MAX_SESSIONS = 12;

/**
 * Phrases that mark the user correcting, contradicting or redirecting. Crude on
 * purpose: a false positive costs a few hundred characters of context, a false
 * negative loses the most valuable thing in the transcript.
 */
/**
 * First line of this file's own prompt, used both to build it and to recognise
 * it. Dream runs in the same workspace as everything else, so its transcripts
 * land in the same directory and are read by the NEXT run. Left unfiltered, it
 * consolidates its own reflections: the previous run's summary looks like an
 * agent turn, and the prompt's own "do NOT write" instructions match the
 * correction regex and get flagged as the user pushing back.
 *
 * Observed on 2026-08-26: the only [PUSHBACK] line in a whole batch was this
 * prompt. That run reasoned its way past it, which is not something to rely on.
 */
const DREAM_MARKER = 'You are consolidating recent sessions into your own long-term memory.';

const CORRECTION =
  /\b(no|nope|actually|instead|wrong|didn'?t|doesn'?t|not what|i meant|rather|stop|revert|undo|don'?t)\b/i;

async function loadState() {
  try {
    return JSON.parse(await readFile(STATE, 'utf8'));
  } catch {
    return { lastRun: 0 };
  }
}

function textOf(entry) {
  const c = entry?.message?.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c
    .filter((b) => b?.type === 'text')
    .map((b) => b.text)
    .join(' ')
    .trim();
}

/** Reduce one transcript to its conversation, dropping every tool call. */
async function distil(path) {
  const raw = await readFile(path, 'utf8');
  const turns = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type !== 'user' && e.type !== 'assistant') continue;
    const t = textOf(e);
    if (!t) continue;
    // The bridge prepends thread context and a location note to the first
    // prompt. That is plumbing, not something the user said.
    if (/^Slack thread so far|^You are replying in Slack channel/.test(t)) continue;
    // A dream session, recognised by its own prompt. Nothing in it is a real
    // conversation, so drop the transcript rather than filtering line by line.
    if (t.startsWith(DREAM_MARKER)) return null;
    turns.push({
      who: e.type === 'user' ? 'USER' : 'AGENT',
      text: t.length > MAX_CHARS_PER_TURN ? `${t.slice(0, MAX_CHARS_PER_TURN)}…` : t,
    });
  }
  if (!turns.length) return null;

  // Keep the tail, which is where corrections and conclusions live, and flag
  // the pushback so the consolidating model does not have to hunt for it.
  const kept = turns.slice(-MAX_TURNS_PER_SESSION);
  const lines = kept.map((t) => {
    const flag = t.who === 'USER' && CORRECTION.test(t.text) ? ' [PUSHBACK]' : '';
    return `${t.who}${flag}: ${t.text}`;
  });
  return { path, turns: kept.length, body: lines.join('\n') };
}

const PROMPT = `${DREAM_MARKER}

Below are two things: a digest of how the user has actually been using their
browser when nobody asked them anything, and transcripts of conversations
between the user and you with tool calls stripped out.

The browsing digest is the more interesting half, because it shows work you were
never told about. A site appearing there that never appears in a conversation is
a project you do not know exists. Sites they return to daily are the tools they
live in. The busiest hours are their working day. Note these as facts about the
user, not as a list of URLs, and never write anything that reads like a
surveillance log.

Lines marked [PUSHBACK] are moments the user corrected,
contradicted or redirected you. Those are the most valuable lines here: a
correction is the user stating a preference at the one moment they cared enough
to interrupt.

Your job is to update the memory tree in \`memory/\` so that a future session
starts already knowing what these sessions taught. Read the existing files first.

What to write:

- **Facts about the user.** How they phrase things, what they consider done, what
  annoys them, what they ask for repeatedly, the vocabulary they use for their own
  tools and projects. This is the category that is currently thinnest and the one
  that makes the difference between a tool and a companion.
- **Corrections, as rules.** "He asked twice for the answer before the detail" is
  a fact. Turn it into the rule it implies.
- **Site and workflow specifics** you had to discover.

What NOT to write:

- Anything you could re-derive in ten seconds.
- One-off task details. "Marked OOO on 25 Aug" is history, not memory.
- Secrets. No passwords, tokens or codes, ever, whatever appeared in a transcript.
- Anything about a person other than the user unless it changes how you should act.

How to write it:

- **Merge, do not append.** If a file already covers the topic, edit that section.
  A memory tree that grows by accretion becomes unreadable and then unread.
- **Date anything that supersedes an earlier note**, and delete what it replaces.
  A file that contradicts itself with no ordering is worse than one that is stale.
- Put facts in \`memory/\`; put repeatable procedures in \`skills/\` instead.
  Write to \`skills/\`, never \`.claude/skills/\`: that path is a symlink to it and
  the harness refuses any write inside \`.claude/\`.
- Keep \`CLAUDE.md\`'s index accurate if you add a file.
- Be brief. Every line here is paid for on every future session.

At the end, output a short plain-text summary of what you changed and why. If the
sessions taught nothing durable, say so and change nothing. That is a valid and
common outcome, and inventing a lesson to look productive is worse than silence.`;

async function main() {
  const dry = process.argv.includes('--dry-run');
  const state = await loadState();
  const since = process.argv.includes('--all') ? 0 : state.lastRun || 0;

  let files;
  try {
    files = await readdir(TRANSCRIPTS);
  } catch {
    console.error(`No transcripts at ${TRANSCRIPTS}`);
    process.exit(1);
  }

  const candidates = [];
  for (const f of files.filter((x) => x.endsWith('.jsonl'))) {
    const p = join(TRANSCRIPTS, f);
    const s = await stat(p);
    if (s.mtimeMs > since) candidates.push({ p, mtime: s.mtimeMs });
  }
  candidates.sort((a, b) => b.mtime - a.mtime);

  if (!candidates.length) {
    console.log('[dream] nothing new since last run');
    return;
  }

  const parts = [];
  for (const { p } of candidates.slice(0, MAX_SESSIONS)) {
    const d = await distil(p);
    if (d) parts.push(`--- session ${d.path.split('/').pop().slice(0, 8)} (${d.turns} turns) ---\n${d.body}`);
  }
  if (!parts.length) {
    console.log('[dream] new transcripts held no conversation');
    return;
  }

  let browsing = null;
  try {
    browsing = renderBrowsing(await observe(since));
  } catch (e) {
    console.log(`[dream] browser history unavailable: ${e.message}`);
  }

  const input = [
    PROMPT,
    browsing ? `=== HOW THEY USED THE BROWSER ===\n${browsing}` : '',
    `=== CONVERSATIONS ===\n${parts.join('\n\n')}`,
  ]
    .filter(Boolean)
    .join('\n\n');
  console.log(
    `[dream] ${parts.length} session(s), ${Math.round(input.length / 1024)}KB of conversation` +
      (dry ? ' (dry run, nothing will be written)' : ''),
  );
  if (dry) {
    console.log(input.slice(0, 4000));
    return;
  }

  const args = [
    '-p',
    input,
    '--output-format',
    'json',
    '--model',
    'opus',
    '--effort',
    'xhigh',
    '--permission-mode',
    'acceptEdits',
    '--allowedTools',
    'Read Write Edit Glob Grep',
    '--disallowedTools',
    'Task Bash WebFetch WebSearch',
  ];

  const child = spawn('claude', args, {
    cwd: WORKSPACE,
    // Same trap as the runner: a piped stdin that never reaches EOF hangs the CLI.
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });

  let out = '';
  let err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));

  const code = await new Promise((r) => child.on('close', r));
  let parsed = null;
  try {
    parsed = JSON.parse(out.trim());
  } catch {
    /* fall through to raw output */
  }

  if (!parsed || parsed.is_error) {
    console.error(`[dream] failed (exit ${code}): ${(err || out).slice(0, 400)}`);
    process.exit(1);
  }

  console.log(`[dream] ${parsed.result}`);
  console.log(`[dream] backup: ${await backup(WORKSPACE)}`);
  await writeFile(
    STATE,
    JSON.stringify({ lastRun: Date.now(), sessions: parts.length, cost: parsed.total_cost_usd }, null, 2),
  );
}

main().catch((e) => {
  console.error('[dream] fatal:', e.message);
  process.exit(1);
});
