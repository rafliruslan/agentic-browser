/**
 * Exit when the Slack socket has been down too long, so launchd restarts the
 * bridge with a fresh one.
 *
 * Socket Mode reconnects on its own, and mostly that works: on a bad network
 * day it dropped and came back 16 times without anyone noticing. Nothing
 * checks that it does come back, though: the client gives up on some errors
 * (apps.connections.open failing on a network error counts as unrecoverable),
 * and a reconnect that never completes logs nothing. The process stays up,
 * launchd sees nothing wrong, and mentions go nowhere until someone asks why
 * the agent stopped answering. That is how 2026-10-15 22:19 looked from the
 * outside: a mention, no event, no log line.
 *
 * So this watches the client's own lifecycle events. "connected" is Slack's
 * hello on a new socket; anything else means there is no socket to deliver
 * on. Down for STALE_MS: exit, the same way binary-watch does. A run still
 * in flight posts its reply over HTTP, not the socket, so it gets up to
 * GRACE_MS more to finish first.
 *
 * Every drop and recovery is logged with a time, so the next incident shows
 * how long the bridge was deaf instead of leaving a guess.
 */

export const CHECK_MS = 30 * 1000;
export const STALE_MS = 3 * 60 * 1000;
export const GRACE_MS = 10 * 60 * 1000;

const DOWN_EVENTS = ['connecting', 'reconnecting', 'disconnecting', 'disconnected'];

/**
 * What to do now. 'ok' while connected or not down long enough, 'wait' while
 * stale but a run is in flight and the grace has not run out, else 'exit'.
 */
export function verdict({ up, since, now, busy = false, staleMs = STALE_MS, graceMs = GRACE_MS }) {
  if (up) return 'ok';
  const down = now - since;
  if (down < staleMs) return 'ok';
  return busy && down < staleMs + graceMs ? 'wait' : 'exit';
}

const secs = (ms) => `${Math.round(ms / 1000)}s`;

/**
 * Follow `client` (a SocketModeClient) and exit once it has been down too
 * long. Starts as connected, because the caller has just awaited app.start().
 * The timer is unref'd. Returns { timer, state } for tests and callers.
 */
export function watchSocket({
  client,
  busy = () => false,
  intervalMs = CHECK_MS,
  staleMs = STALE_MS,
  graceMs = GRACE_MS,
  now = () => Date.now(),
  log = console,
  exit = (code) => process.exit(code),
}) {
  const state = { up: true, since: now() };
  const stamp = () => new Date(now()).toISOString();

  client.on('connected', () => {
    if (!state.up) log.log?.(`[slack] ${stamp()} reconnected after ${secs(now() - state.since)} down`);
    state.up = true;
    state.since = now();
  });
  for (const name of DOWN_EVENTS) {
    client.on(name, () => {
      if (!state.up) return;
      state.up = false;
      state.since = now();
      log.log?.(`[slack] ${stamp()} socket ${name}, waiting for it to come back`);
    });
  }

  let waiting = false;
  const timer = setInterval(() => {
    const v = verdict({ ...state, now: now(), busy: busy(), staleMs, graceMs });
    if (v === 'ok') { waiting = false; return; }
    if (v === 'wait') {
      if (!waiting) log.error?.(`[slack] ${stamp()} socket down ${secs(now() - state.since)}; a run is in flight, restarting once it ends`);
      waiting = true;
      return;
    }
    clearInterval(timer);
    log.error?.(`[slack] ${stamp()} socket down ${secs(now() - state.since)} and not coming back; exiting so launchd restarts the bridge`);
    exit(0);
  }, intervalMs);
  timer.unref?.();
  return { timer, state };
}
