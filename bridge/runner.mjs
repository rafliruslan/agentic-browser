/**
 * Runs one the agent turn against Claude Code.
 *
 * This is the module that replaced the macOS-only `runner.mjs`, which shelled
 * out to a macOS-only agent CLI. Everything else in the bridge is unchanged.
 *
 * Four findings drove the original design against that CLI. Three of
 * them do not survive the move, because Claude Code has a structured interface
 * that Claude Code has and it did not:
 *
 *   F1 session id is undiscoverable  -> gone. `--session-id <uuid>` assigns it.
 *   F2 exits 0 on hard errors        -> gone. JSON carries `is_error`/`subtype`.
 *   F3 ANSI escapes in stdout        -> gone. JSON on stdout.
 *   F4 hangs unless stdin is closed  -> STILL APPLIES. Node's spawn default is
 *      stdio ['pipe','pipe','pipe'], leaving the child holding a stdin pipe
 *      that never reaches EOF. Measured on the Mac: hung >35s vs 779ms with
 *      stdin ignored. No mocked-spawn unit test can catch this.
 *
 * Also measured, and contrary to what the previous harness did: a headless
 * Claude Code run that hits a permission boundary does NOT hang. It records the
 * refusal in `permission_denials`, tells the user plainly, and exits success in
 * ~12s. That is why this runner uses a real permission mode and a scoped cwd
 * rather than bypassing permissions to avoid a stall that cannot happen.
 */

import { spawn } from 'node:child_process';
import { createMirror, splitLines, resultOf } from './mirror.mjs';
import { appendRun, indexPathFor } from './runs-index.mjs';

/**
 * A turn that outruns this is killed. Browser work is genuinely slow.
 *
 * 15 minutes, matching what Aside allows per task in its own benchmark runs.
 * Ten was this codebase's guess; theirs is the number a 297/300 result was
 * measured with, on the same kind of live-website work.
 */
export const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Claude Code says this when a `--resume` target is gone. The Mac hit the same
 * class of failure constantly: the old harness evicted 442 session directories against
 * 152 registered rows. Detect, forget, retry fresh, never show the user.
 */
const DEAD_SESSION = /no conversation found|session .*not found|could not (find|resume)/i;

/**
 * The opposite failure: the id we tried to ASSIGN already belongs to a session.
 * Means the session exists and should have been resumed. Distinct from a dead
 * session, and the caller recovers differently, so it gets its own signal.
 */
const SESSION_IN_USE = /session id .* is already in use/i;

/**
 * Tools the agent must never get, enforced in code rather than in the persona.
 *
 * The hardest-won lesson: the persona asked the agent not to spawn subagents
 * and it did so anyway, often enough to matter. Every rule that CAN be made
 * deterministic MUST be, which is also what let the persona shrink 82%.
 *
 * `Task`                            one Slack message must be one session, or a
 *                                   single mention becomes four sidebar entries.
 *
 * `mcp__browser__browser_run_code_unsafe`
 *                                   arbitrary JS against a live logged-in page.
 *                                   Observed 2026-08-25: `browser_click` cannot
 *                                   work on Google Calendar (the ref resolves
 *                                   but Playwright's stability check never
 *                                   passes), the agent escalated to raw JS against a
 *                                   half-open dialog, and left a ghost "No
 *                                   title" out-of-office event that then had to
 *                                   be hunted down. `browser_evaluate` against a
 *                                   specific ref is the supported escape hatch
 *                                   and is still allowed; unscoped page scripting
 *                                   is not.
 *
 * `mcp__devtools__evaluate_script`
 *                                   the chrome-devtools-mcp equivalent of the
 *                                   above. Denied for the same reason, so
 *                                   adding a second browser server does not
 *                                   quietly reopen the door we just shut.
 *
 * Aside, the macOS browser layer, cannot be constrained this way and it is
 * worth being blunt about it. `aside mcp` exposes exactly one tool, `repl`,
 * which executes arbitrary JavaScript against the live logged-in browser. There
 * is no granular `click(ref)` to allow instead, so the capability these two
 * entries exist to remove IS the entire API. Denying it would leave the agent
 * with no browser; allowing it grants, on that machine, precisely what was
 * taken away on the other one.
 *
 * So the guardrail on macOS is not the tool list. It is the workspace cwd, the
 * single allowed Slack user, and the fact that a human reads every reply. That
 * is a real reduction in safety against the Linux setup, and someone running
 * both should know which machine they are talking to.
 *
 * The two Brave entries stay listed on both. They cost nothing when the server
 * is absent, and leaving them means attaching Brave later cannot quietly reopen
 * a door that was shut deliberately.
 */
export const DENIED_TOOLS = [
  'Task',
  'mcp__browser__browser_run_code_unsafe',
  'mcp__devtools__evaluate_script',
];

export function buildArgs({ prompt, sessionId, isNew, model, effort, permissionMode, mcpConfig, allowedTools, deniedTools }) {
  // stream-json rather than json, so the supervisor can mirror the run into a
  // transcript it owns rather than reading Claude Code's. --verbose is not
  // optional: the CLI refuses stream-json with --print without it.
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose'];

  // A new thread ASSIGNS its deterministic id; a continuing thread resumes it.
  // A new run with no id at all is legal - a routine has no thread to derive
  // one from - and must not pass the flag, since spawn rejects a null argv
  // entry and would take the whole run down before the CLI ever started.
  if (isNew) {
    if (sessionId) args.push('--session-id', sessionId);
  } else {
    args.push('--resume', sessionId);
  }

  if (model) args.push('--model', model);
  // Both are per-invocation, so a resumed thread can escalate to a stronger
  // model for one turn and drop back afterwards without starting over.
  if (effort) args.push('--effort', effort);
  if (permissionMode) args.push('--permission-mode', permissionMode);
  // `--strict-mcp-config` is what stops the agent seeing tools she cannot use.
  // Without it the agent inherits every user-scope MCP server from ~/.claude.json
  // (Gmail, Calendar, Drive, Excalidraw, Linear, Slack...), which ALLOWED_TOOLS
  // then denies. Observed twice in real threads: the agent picked the Calendar tool,
  // was refused, and reported "needs permission" while Google Calendar sat open
  // and logged in one tab away. A tool that is visible but denied is worse than
  // one that does not exist, because it stops her before she tries the browser.
  if (mcpConfig) args.push('--mcp-config', mcpConfig, '--strict-mcp-config');
  if (allowedTools?.length) args.push('--allowedTools', allowedTools.join(' '));
  // Callers may narrow further, never widen: the module list is always applied.
  args.push('--disallowedTools', [...new Set([...DENIED_TOOLS, ...(deniedTools || [])])].join(' '));

  return args;
}

/**
 * Execute one turn.
 *
 * Returns a structured result. Never throws for an agent-level failure; the
 * caller decides what reaches Slack.
 *
 * @returns {Promise<{ok:boolean, text:string, sessionId:string|null,
 *   deadSession:boolean, denials:Array, costUsd:number|null, timedOut:boolean,
 *   raw:string}>}
 */
export function runAgent({
  prompt,
  sessionId,
  isNew = false,
  cwd,
  model = null,
  effort = null,
  permissionMode = 'acceptEdits',
  mcpConfig = null,
  allowedTools = null,
  deniedTools = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  bin = 'claude',
  spawnFn = spawn,
  onSpawn = null,
  transcriptPath = null,
} = {}) {
  return new Promise((resolve) => {
    const args = buildArgs({ prompt, sessionId, isNew, model, effort, permissionMode, mcpConfig, allowedTools, deniedTools });

    const child = spawnFn(bin, args, {
      cwd,
      // F4. Do not change this to 'pipe'. It silently breaks every run.
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    // Handed out so a caller can stop this run. The child was previously
    // reachable only from inside here, which is why the bridge could start a
    // run and then had no way to end one.
    if (typeof onSpawn === 'function') {
      try {
        onSpawn(child);
      } catch (err) {
        // A broken listener must not take the run down with it.
        console.error(`[runner] onSpawn threw: ${err.message}`);
      }
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    // Parsed stream objects and the transcript, both filled as the run
    // streams; the result line is the last thing to arrive. The mirror exists
    // from the first byte on purpose - opening the file first would race the
    // CLI's opening chunks and lose them.
    const objects = [];
    let buffered = '';
    let range = null;
    const mirror = createMirror();
    // What was asked, first, because the stream will never say. On a resumed
    // thread this is that turn's prompt, and the first one in the file is the
    // one the listing shows.
    mirror.record({ type: 'user', message: { content: prompt } });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      stdout += d;
      // Whole lines only. A chunk routinely cuts an object in half, and the
      // last line of a killed run is half an object that must never be parsed
      // or mirrored.
      const split = splitLines(buffered, String(d));
      buffered = split.rest;
      for (const line of split.lines) {
        const obj = mirror.take(line);
        if (obj) objects.push(obj);
      }
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        text: `Bridge could not start the agent: ${err.message}`,
        sessionId: null,
        deadSession: false,
        sessionInUse: false,
        denials: [],
        costUsd: null,
        timedOut: false,
        raw: String(err),
      });
    });

    child.on('close', async () => {
      clearTimeout(timer);
      // Flush the transcript before reporting. A killed run still wrote real
      // bytes and they belong in the record; only the half line at the end is
      // dropped, and splitLines never handed it over. A failed write must not
      // take down a run that otherwise succeeded, so it is logged, not thrown.
      if (transcriptPath) {
        try {
          range = await mirror.writeTo(transcriptPath);
          // Recorded here, in the one place that knows the range, rather than
          // at each caller. The id is the one the transcript is named after,
          // so the index and the file can never disagree about which session a
          // turn belongs to.
          await appendRun(indexPathFor(transcriptPath), { session: sessionId, ...range });
        } catch (err) {
          console.error(`[runner] transcript mirror failed: ${err.message}`);
        }
      }
      const combined = `${stdout}\n${stderr}`;

      if (timedOut) {
        return resolve({
          ok: false,
          text: `The agent ran past ${Math.round(timeoutMs / 60000)} minutes and was stopped. Nothing was reported back, so treat the task as unfinished.`,
          sessionId: null,
          deadSession: false,
          denials: [],
          costUsd: null,
          timedOut: true,
          raw: combined,
        });
      }

      const parsed = resultOf(objects);
      if (!parsed) {
        // No result line means the CLI failed before it produced one, which is
        // also exactly what a run killed by !stop looks like.
        return resolve({
          ok: false,
          text: combined.trim() || 'The agent produced no output.',
          sessionId: null,
          deadSession: DEAD_SESSION.test(combined),
          sessionInUse: SESSION_IN_USE.test(combined),
          denials: [],
          costUsd: null,
          timedOut: false,
          raw: combined,
          range,
        });
      }

      const text = String(parsed.result ?? '').trim();
      // F2's lesson survives in spirit: never trust one signal. An error can be
      // flagged, or typed as a non-success subtype, or only visible in the text.
      const failed =
        parsed.is_error === true || (parsed.subtype && parsed.subtype !== 'success');

      resolve({
        ok: !failed,
        text,
        sessionId: parsed.session_id ?? null,
        deadSession: DEAD_SESSION.test(`${text}\n${combined}`),
        sessionInUse: SESSION_IN_USE.test(`${text}\n${combined}`),
        denials: parsed.permission_denials ?? [],
        costUsd: typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : null,
        timedOut: false,
        raw: stdout,
        // Where this turn's bytes landed in our transcript. Null when no
        // transcript was asked for.
        range,
      });
    });
  });
}
