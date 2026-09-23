/**
 * Slack Socket Mode bridge.
 *
 * Mentions arrive here, become one Claude Code session per thread, and the
 * answer is edited back over the placeholder this posted.
 *
 * The operational rule that makes this safe: Socket Mode permits multiple
 * concurrent connections and Slack delivers `app_mention` to EVERY one of them.
 * Two bridges running against the same app means every mention is answered
 * twice, by two agents that cannot see each other, in the same thread. Run one.
 */

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir, hostname } from 'node:os';
import bolt from '@slack/bolt';

import { PERSONA } from './persona.mjs';
import { createSessionStore, DEFAULT_STATE_PATH } from './sessions.mjs';
import { createPendingStore, DEFAULT_PENDING_PATH } from './pending.mjs';
import { createQueue } from './queue.mjs';
import { fetchThreadContext, composeTask, locationNote } from './thread.mjs';
import { parseMention, formatResult } from './text.mjs';
import { buildBlocks } from './blocks.mjs';
import { runAgent } from './runner.mjs';
import { transcriptPathFor } from './mirror.mjs';
import { readIdentity, identityNote } from './identity.mjs';
import { healBrowser } from './browser-health.mjs';
import { pickModel, stripDirective } from './router.mjs';
import { acquire, release } from './lock.mjs';
import { react, settle, setStatus, WORKING } from './status.mjs';
import { createSubscriptionStore, shouldHandle, isStopPhrase, canInterrupt } from './subscriptions.mjs';
import { allowedTools, browserCdpUrl, deniedBrowserTools, BASE_TOOLS } from './browser.mjs';
import { parseInterrupt } from './interrupt.mjs';
import { createRunRegistry } from './runs.mjs';

const { App } = bolt;

const ENV_PATH = process.env.AGENT_ENV_PATH || join(homedir(), '.config', 'agentic-browser', 'env');
const WORKSPACE = process.env.AGENT_WORKSPACE || join(homedir(), '.local', 'share', 'agentic-browser', 'workspace');
const MCP_CONFIG = process.env.AGENT_MCP_CONFIG || join(homedir(), '.config', 'agentic-browser', 'mcp.json');

/**
 * Tools the agent may use without being asked.
 *
 * The browser half is derived from the MCP config at startup rather than named
 * here, because which browser the agent drives is a deployment choice: Brave
 * over CDP on Linux, Aside on macOS. See browser.mjs.
 *
 * What bounds the agent is the workspace cwd and the denied tools, not a
 * per-action prompt. There is no human at a headless run to answer one, and a
 * denial surfaces as an honest refusal in Slack rather than a stall.
 *
 * Resolved once at startup, not per message: re-reading the file on every
 * mention would let a half-written edit disarm the browser mid-conversation.
 *
 * Why the Linux config names three servers, kept here because the measurements
 * are the reason and a JSON file cannot hold them:
 *
 *   `brave`      Playwright. The whole browser surface: accessibility snapshot
 *                with refs, navigation, clicking, typing, screenshots.
 *
 *   `devtools`   chrome-devtools-mcp, on the same CDP endpoint. Added because
 *                Playwright's click has an actionability gate that Google
 *                Calendar never satisfies: the ref resolves but "stable" never
 *                passes on its animating containers. Measured 2026-08-25, same
 *                button, same page: playwright `browser_click` failed three
 *                times; devtools click succeeded on the first attempt.
 *
 *   `browser-repl` the same browser again, but its snapshot returns a DIFF.
 *                Measured on Google Calendar: 5415 bytes for the full tree
 *                against 227 for the diff after opening a menu. Re-reading a
 *                page is the most repeated thing the agent does, so this is
 *                where the tokens are.
 *
 * Aside exposes one tool instead of these three. See browser.mjs and the
 * safety note on DENIED_TOOLS in runner.mjs.
 */
let ALLOWED_TOOLS = BASE_TOOLS;

/**
 * Arbitrary-script tools, named for whatever this machine calls its browser.
 * Derived at startup rather than written down, so renaming the server cannot
 * quietly unblock them.
 */
let DENIED = [];

/**
 * Which browser profile the agent drives, when that is knowable.
 *
 * Read once at startup: a profile does not change under a running browser, and
 * doing it per turn would read the same file on every message. Null when the
 * browser has no user-data-dir to read, which is the normal case for one
 * driven through its own process.
 */
let IDENTITY = null;

/** Where the browser keeps its profiles, and which one the launcher pinned. */
const BROWSER_DATA_DIR = process.env.AGENT_BROWSER_DATA_DIR || null;
const BROWSER_PROFILE_DIR = process.env.AGENT_BROWSER_PROFILE_DIR || null;

/**
 * Whether an untagged reply in a followed thread is an instruction.
 *
 * Off by default: talking in a thread she is in should not mean talking TO
 * her. Interrupts are unaffected - `!stop` and `!steer` go through
 * canInterrupt, which never wanted a tag, so stopping a run you are watching
 * still needs no @.
 */
const MENTION_ONLY = process.env.AGENT_MENTION_ONLY !== '0';

/** Threads run one at a time; this caps how many threads run together. */
const DEFAULT_CONCURRENCY = 3;

/**
 * Channels the agent will answer in. `*` means any channel it has been invited
 * to, which is already gated by Slack: it only receives `app_mention` from
 * channels someone added her to. A comma-separated list narrows it further.
 */
function channelAllowed(allowed, channel) {
  if (!allowed || allowed === '*') return true;
  return allowed
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean)
    .includes(channel);
}


/**
 * Read the KEY=VALUE env file. Kept out of the repo and out of any transcript;
 * mode 600. ALLOWED_USER is the entire security boundary for this bot.
 */
async function loadEnv(path = ENV_PATH) {
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    // First run lands here. A bare ENOENT tells someone who has never seen this
    // project nothing about what to do next.
    if (err.code === 'ENOENT') {
      throw new Error(
        `No config at ${path}\n\n` +
          `  mkdir -p ${dirname(path)}\n` +
          `  cp bridge/config.example/* ${dirname(path)}/\n` +
          `  chmod 600 ${path}\n\n` +
          `Then fill in SLACK_BOT_TOKEN, SLACK_APP_TOKEN and ALLOWED_USER. ` +
          `Set AGENT_ENV_PATH to use a different location.`,
      );
    }
    throw err;
  }
  const out = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

/**
 * Adapt a runner result to the shape `formatResult` expects.
 *
 * text.mjs predates this runner, which returned
 * `{ ok, output, error, timedOut }`. Bending the caller keeps that module
 * byte-identical, which matters: it encodes five Slack rendering faults that
 * were each found in a live channel rather than by any test.
 */
function toLegacyResult(r) {
  return {
    ok: r.ok,
    output: r.text,
    error: r.ok ? '' : r.text,
    timedOut: r.timedOut,
  };
}

async function main() {
  const env = await loadEnv();
  const { SLACK_BOT_TOKEN, SLACK_APP_TOKEN, ALLOWED_USER, ALLOWED_CHANNEL, MAX_CONCURRENT } = env;

  const concurrency = Number.parseInt(MAX_CONCURRENT, 10) > 0
    ? Number.parseInt(MAX_CONCURRENT, 10)
    : DEFAULT_CONCURRENCY;

  if (!SLACK_BOT_TOKEN || !SLACK_APP_TOKEN) {
    throw new Error(`SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be set in ${ENV_PATH}`);
  }
  if (!ALLOWED_USER) {
    throw new Error(`ALLOWED_USER must be set in ${ENV_PATH}; it is the only access control`);
  }

  // Which browser is attached, read once. A warning rather than a throw: losing
  // the browser should not cost you the channel you would use to ask about it.
  ALLOWED_TOOLS = await allowedTools(MCP_CONFIG);
  DENIED = await deniedBrowserTools(MCP_CONFIG);

  IDENTITY = await readIdentity({
    userDataDir: BROWSER_DATA_DIR,
    profileDir: BROWSER_PROFILE_DIR,
  });
  if (IDENTITY) {
    console.log(`[browser] driving profile ${IDENTITY.description}`);
    // Worth a line of its own. The failure it prevents is silent: the agent
    // reads an inbox as the wrong person, finds nothing, and reports nothing
    // wrong.
    if (IDENTITY.mismatch) {
      console.log(`[browser] NOTE: he is probably in ${IDENTITY.mismatch.humanLikelyIn}, not ${IDENTITY.mismatch.driving}`);
    }
  }
  const browsers = ALLOWED_TOOLS.filter((t) => t.startsWith('mcp__'));
  // Only a CDP browser can be preflighted, and only a CDP browser wedges the
  // way the preflight looks for. Null here means the check is skipped rather
  // than run and failed, which is what it used to do on every single run.
  const cdpUrl = await browserCdpUrl(MCP_CONFIG);
  console.log(
    `[browser] ${browsers.length ? browsers.join(', ') : 'none attached'} (from ${MCP_CONFIG})` +
    `${cdpUrl ? `, CDP at ${cdpUrl}` : ', not CDP, health preflight off'}`,
  );

  const app = new App({
    token: SLACK_BOT_TOKEN,
    appToken: SLACK_APP_TOKEN,
    socketMode: true,
  });

  const sessions = createSessionStore({ path: DEFAULT_STATE_PATH });
  const pendingStore = createPendingStore({ path: DEFAULT_PENDING_PATH });
  const queue = createQueue({ concurrency });

  const auth = await app.client.auth.test({ token: SLACK_BOT_TOKEN });
  const botUserId = auth.user_id;

  // Anything still recorded belongs to a process that is already gone, so
  // nothing alive will ever finish it. Found on the Mac after 29 restarts: a
  // placeholder from 12:38 still said "running…" at 21:41.
  //
  // There is no placeholder to edit now, but the same leak exists in a quieter
  // form: the 👀 reaction and the assistant status line are both set before the
  // run and cleared after, so a process that dies in between leaves a thread
  // that looks like it is still being worked on, forever. Clearing them is the
  // point of this loop; the message is so it is not silent.
  const orphans = await pendingStore.takeAll();
  if (orphans.length) {
    // Silent recovery is indistinguishable from no recovery, and the two mean
    // very different things after a restart: one says a run was destroyed.
    console.warn(`[agent] ${orphans.length} run(s) were cut off by a restart; clearing and reporting`);
  }
  for (const orphan of orphans) {
    try {
      await settle(app.client, { channel: orphan.channel, ts: orphan.ts, ok: false, logger: console });
      await setStatus(app.client, { channel: orphan.channel, threadTs: orphan.threadTs, status: '', logger: console });
      await app.client.chat.postMessage({
        token: SLACK_BOT_TOKEN,
        channel: orphan.channel,
        thread_ts: orphan.threadTs,
        text: '❌ The bridge restarted while this was running. Ask me again.',
      });
    } catch {
      // The thread may be gone; an orphan is not worth crashing for.
    }
  }

  const pruned = await sessions.prune();
  if (pruned) console.log(`[agent] retired ${pruned} stale session(s)`);

  const subscriptions = createSubscriptionStore();

  // She answers when tagged. She reads the thread either way: the next turn
  // pastes the whole thread, so anything said while she was quiet is still in
  // front of her when she is finally tagged. AGENT_MENTION_ONLY=0 restores the
  // older behaviour, where a plain reply in a followed thread was enough.
  app.event('message', async ({ event, client }) => {
    if (!channelAllowed(ALLOWED_CHANNEL, event.channel)) return;

    // Before the subscription gate, deliberately. A thread is subscribed only
    // after the agent has replied, so during the run you want to stop it is
    // not subscribed yet and shouldHandle drops the message. canInterrupt
    // keeps every other check, including who is allowed to drive the agent.
    if (canInterrupt(event, { botUserId, allowedUser: ALLOWED_USER })
        && await handleInterrupt({ event, client, text: event.text })) {
      return;
    }

    // Not read at all when only a mention speaks to her, so it is not looked
    // up: this runs on every message in every channel the bot is in, and a
    // disk read per message to compute a value nobody uses is the kind of cost
    // that only shows up in a busy workspace.
    const subscribed = MENTION_ONLY ? false : await subscriptions.isSubscribed(event.thread_ts);
    if (!shouldHandle(event, { botUserId, allowedUser: ALLOWED_USER, subscribed, mentionOnly: MENTION_ONLY })) return;
    if (isStopPhrase(event.text)) {
      await subscriptions.unsubscribe(event.thread_ts);
      await react(client, { channel: event.channel, ts: event.ts, name: 'wave', logger: console });
      console.log(`[agent] unfollowed ${event.thread_ts}`);
      return;
    }
    if (await handleInterrupt({ event, client, text: event.text })) return;
    await handleTurn({ event, client, text: event.text });
  });

  const runs = createRunRegistry({ log: console });

  /**
   * Cut into a thread that is already working.
   *
   * This deliberately runs BEFORE queue.add. Queueing an interrupt would put
   * it behind the very run it is trying to end, which is the whole problem:
   * today a "no, stop" reply is read only after the agent has finished doing
   * the wrong thing.
   *
   * @returns {Promise<boolean>} true when the message was an interrupt and is
   *   fully handled, so the caller must not also treat it as a turn.
   */
  async function handleInterrupt({ event, client, text }) {
    const parsed = parseInterrupt(text ?? event.text);
    if (!parsed) return false;

    const threadTs = event.thread_ts || event.ts;
    // Read before stopping: the handle goes away with the run.
    const startedBy = runs.startedBy(threadTs);
    const stopped = runs.stop(threadTs);

    // Clear the progress signals the run set, by the same calls a normal finish
    // uses, and against the message that STARTED it rather than this one.
    // Skipping this leaves a 👀 on the original message and a pending record
    // the next boot sweeps up and apologises for.
    await setStatus(client, { channel: event.channel, threadTs, status: '', logger: console });
    if (startedBy) {
      await settle(client, { channel: startedBy.channel, ts: startedBy.ts, ok: false, logger: console });
      await pendingStore.remove(startedBy.channel, startedBy.ts);
    }

    if (parsed.stop) {
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: threadTs,
        text: stopped
          ? 'Stopped. Whatever it was partway through stays partway through.'
          : 'Nothing was running.',
      });
      console.log(`[agent] stop ${threadTs} (killed=${stopped})`);
      return true;
    }

    console.log(`[agent] steer ${threadTs} (killed=${stopped})`);
    // Re-enter as an ordinary turn carrying the new instruction. The session
    // id comes from the thread, so the conversation continues; only the step
    // that was in flight is lost.
    await handleTurn({ event, client, text: parsed.prompt });
    return true;
  }

  // One path for both entry points: a mention, and a reply in a followed thread.
  async function handleTurn({ event, client, text }) {
    // The whole access control. Anyone else in the channel is ignored in
    // silence: replying would tell an unauthorised user the bot is listening.
    if (event.user !== ALLOWED_USER) {
      console.log(`[agent] ignored mention from ${event.user}`);
      return;
    }
    if (!channelAllowed(ALLOWED_CHANNEL, event.channel)) {
      console.log(`[agent] ignored mention in ${event.channel}`);
      return;
    }

    const channel = event.channel;
    const threadTs = event.thread_ts || event.ts;
    const mentioned = parseMention(text ?? event.text, botUserId);
    // Route on what the user typed, then strip the routing marker so the model is
    // never handed "deep:" as part of the task.
    const route = pickModel(mentioned);
    const prompt = stripDirective(mentioned);

    await queue.add(threadTs, async () => {
      let ok = false;

      try {
        // Recorded BEFORE the run, cleared after: that ordering is what makes
        // "still present at startup" mean "orphaned" and nothing else. Keyed
        // on the triggering message, which is also what carries the reaction.
        await pendingStore.add(channel, event.ts, { threadTs });
        // The two progress signals, and there is no longer a third. A
        // "running…" placeholder used to say the same thing in the one form
        // that persists, so it had to be edited away afterwards; these do not.
        // The reaction shows in the channel list, the status inside the thread.
        // Both are best effort: without the scopes they no-op, and then the
        // reply arriving is the only signal, which is how this worked before.
        await react(client, { channel, ts: event.ts, name: WORKING, logger: console });
        await setStatus(client, { channel, threadTs, status: 'Working…', logger: console });
        console.log(`[agent] ${threadTs} -> ${route.model}/${route.effort} (${route.reason})`);

        const threadContext = await fetchThreadContext(client, {
          channel,
          threadTs,
          botUserId,
          skipTs: event.ts,
          allowedUser: ALLOWED_USER,
        });

        const existing = await sessions.get(threadTs);
        const sessionId = existing || (await sessions.idFor(threadTs));
        const isNew = !existing;

        const task = composeTask(prompt, threadContext);
        // Who she is browsing as, before what she is being asked. An empty
        // string when unknown, so nothing is claimed that is not known.
        const note = [identityNote(IDENTITY), locationNote({ channel, threadTs })]
          .filter(Boolean)
          .join('\n\n');
        // Persona on a thread's first turn only. After that it lives in the
        // session history, and repeating it makes her restate herself.
        const full = [isNew ? PERSONA : '', task, '\n\n---\n\n', note]
          .filter(Boolean)
          .join('');

        // Record the mapping BEFORE the run, not after a successful one.
        //
        // Claude Code creates the session the moment it starts, whatever the
        // outcome. Recording only on success meant a run that timed out left no
        // mapping, so the next message in that thread saw no session, assigned
        // the same deterministic id again, and hit a session that already
        // existed. Seen in production 2026-08-27, two messages after a ten
        // minute timeout: "Session ID de620be8-a781-4d68-8831-35a44e0555b7 is
        // already in use."
        //
        // If the spawn fails outright no session exists, and the next run's
        // `--resume` reports it gone, which the dead-session path below handles.
        if (isNew) await sessions.set(threadTs, sessionId);

        // Clear any target that has stopped answering CDP before handing over.
        //
        // All three browser servers connect by enabling Runtime and Network on
        // every target, so one wedged target times out every browser call the
        // agent makes and there is nothing it can do about it from the inside.
        // Measured 2026-08-27: one stuck Calendar tab and three of WhatsApp
        // Web's WASM VoIP workers took the whole browser layer down for a full
        // run. See browser-health.mjs.
        if (cdpUrl) {
          try {
            const health = await healBrowser({ cdpUrl });
            if (health.healed) console.log(`[browser-health] cleared ${health.healed} wedged target(s)`);
          } catch (err) {
            console.warn(`[browser-health] preflight failed, continuing: ${err.message}`);
          }
        }

        let result = await runAgent({
          prompt: full,
          sessionId,
          isNew,
          cwd: WORKSPACE,
          model: route.model,
          effort: route.effort,
          mcpConfig: MCP_CONFIG,
          allowedTools: ALLOWED_TOOLS,
          deniedTools: DENIED,
          transcriptPath: transcriptPathFor(WORKSPACE, sessionId),
          onSpawn: (child) => runs.track(threadTs, child, { channel, ts: event.ts }),
        });

        // Belt and braces for the same failure arriving another way: if the id
        // is taken, the session exists and we should have resumed it.
        if (!result.ok && result.sessionInUse) {
          console.log(`[agent] ${sessionId} already exists; resuming instead`);
          await sessions.set(threadTs, sessionId);
          result = await runAgent({
            prompt: task + '\n\n---\n\n' + note,
            sessionId,
            isNew: false,
            cwd: WORKSPACE,
            model: route.model,
            effort: route.effort,
            mcpConfig: MCP_CONFIG,
            allowedTools: ALLOWED_TOOLS,
            deniedTools: DENIED,
            transcriptPath: transcriptPathFor(WORKSPACE, sessionId),
            onSpawn: (child) => runs.track(threadTs, child, { channel, ts: event.ts }),
          });
        }

        // A resumed session that is gone never recovers. Release the thread and
        // silently retry in a fresh one rather than showing the user an error.
        if (!result.ok && result.deadSession && !isNew) {
          console.log(`[agent] session ${sessionId} is gone; restarting thread ${threadTs}`);
          await sessions.forget(threadTs);
          const freshId = await sessions.idFor(threadTs);
          result = await runAgent({
            prompt: PERSONA + task + '\n\n---\n\n' + note,
            sessionId: freshId,
            isNew: true,
            cwd: WORKSPACE,
            model: route.model,
            effort: route.effort,
            mcpConfig: MCP_CONFIG,
            allowedTools: ALLOWED_TOOLS,
            deniedTools: DENIED,
            transcriptPath: transcriptPathFor(WORKSPACE, freshId),
            onSpawn: (child) => runs.track(threadTs, child, { channel, ts: event.ts }),
          });
          if (result.ok) await sessions.set(threadTs, freshId);
        } else if (result.ok) {
          await sessions.set(threadTs, result.sessionId || sessionId);
        }

        if (result.denials?.length) {
          console.log(`[agent] ${result.denials.length} permission denial(s) in ${threadTs}`);
        }

        // A run killed by !stop exits non-zero and reports failure, so this
        // posted "❌ Failed." immediately before "Stopped." Nothing went
        // wrong, and the thread read as though it had. The mark is taken, not
        // peeked, so the next run on this thread is judged on its own result.
        if (runs.takeStopped(threadTs)) {
          console.log(`[agent] ${threadTs} was stopped on purpose; not posting the run result`);
          return;
        }

        const body = formatResult(toLegacyResult(result));
        const blocks = buildBlocks(body);

        await client.chat.postMessage({
          channel,
          thread_ts: threadTs,
          text: body,
          ...(blocks ? { blocks } : {}),
        });
        ok = !/^(❌|⏱|🌐|⚠️)/.test(body);
        // Follow the thread so the next turn needs no mention.
        // Only worth recording when a follow-up could act on it. Under
        // mention-only nothing reads the store, so writing it every reply just
        // grows a file that is never opened.
        if (ok && !MENTION_ONLY) await subscriptions.subscribe(threadTs, { channel });
      } catch (err) {
        console.error('[agent] run failed:', err);
        try {
          await client.chat.postMessage({
            channel,
            thread_ts: threadTs,
            text: `❌ bridge error: ${err.message}`,
          });
        } catch {
          // Nothing further to do; the finally below clears the record.
        }
      } finally {
        await settle(client, { channel, ts: event.ts, ok, logger: console });
        await setStatus(client, { channel, threadTs, status: '', logger: console });
        await pendingStore.remove(channel, event.ts);
      }
    });
  }

  app.event('app_mention', async ({ event, client }) => {
    if (await handleInterrupt({ event, client, text: event.text })) return;
    await handleTurn({ event, client, text: event.text });
  });

  // Refuse to become a second answering bridge. Slack fans app_mention out to
  // every Socket Mode connection, so a duplicate does not error, it just makes
  // the agent look like it contradicts itself.
  const lock = await acquire();
  if (!lock.ok) {
    // "Stop that one first" is bad advice when the holder is on a different
    // machine: there is nothing local to stop, and nothing here can prove it
    // dead either, so the file is the only way out.
    const elsewhere = lock.holder.host && lock.holder.host !== hostname();
    console.error(
      `[agent] another bridge holds the lock: pid ${lock.holder.pid} on ` +
      `${lock.holder.host} since ${lock.holder.since}. Refusing to start, because ` +
      `two bridges answer every mention twice. ` +
      (elsewhere
        ? `That is a different machine, so this one cannot tell whether it is still alive. ` +
          `Stop it there, or delete the lock file if you know it is gone.`
        : `Stop that one first.`),
    );
    process.exit(1);
  }
  if (lock.tookOver) console.log('[agent] took over a stale lock from a dead process');
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { release().finally(() => process.exit(0)); });
  }

  await app.start();
  console.log(`[agent] connected as ${auth.user} (${botUserId}) in ${auth.team}`);
  console.log(`[agent] workspace ${WORKSPACE}, concurrency ${concurrency}, channels ${ALLOWED_CHANNEL || '*'}`);
}

main().catch((err) => {
  console.error('[agent] fatal:', err.message);
  process.exit(1);
});
