/**
 * Detect and clear targets that have stopped answering CDP.
 *
 * All three browser servers die together when a single target wedges, and the
 * failure is invisible from the outside: the browser looks fine, /json/version
 * answers in milliseconds, every tab renders. What breaks is that Playwright and
 * Puppeteer both enable Runtime and Network on EVERY target when they connect,
 * and then wait for all of it. One target that never replies blocks the whole
 * connect, so the agent gets a 30 second timeout on every browser call and no
 * indication of why.
 *
 * Measured 2026-08-27, the second timeout in two days: 735 CDP commands sent on
 * connect, 712 answered, 23 unanswered. Those 23 came from exactly two targets,
 * one wedged Google Calendar tab and WhatsApp Web's WASM VoIP workers. With
 * those two cleared, connectOverCDP went from a hard 30s timeout to 935ms.
 *
 * The agent cannot route around this. On that run it tried brave, browser-repl and
 * devtools, got a timeout from all three, and spent its remaining budget writing
 * a raw CDP client in Bash because raw CDP can talk to one target without
 * enabling anything on the others. That worked, and it is also the reason the
 * task was never finished.
 *
 * So this runs before the agent does, not as advice to it.
 *
 * WhatsApp respawns its workers immediately, so closing them is not a fix on its
 * own. It is still correct to close them: a respawned worker is usually healthy,
 * and the one that was blocking is gone.
 */

// BRAVE_CDP_URL still works, the same bargain observe.mjs struck with
// BRAVE_HISTORY_DB: it was the name before the agent drove anything but Brave,
// and silently ignoring an already-configured machine is the worse trade.
const DEFAULT_CDP_URL =
  process.env.AGENT_CDP_URL || process.env.BRAVE_CDP_URL || 'http://127.0.0.1:9222';

/** Per target. Generous: a busy page can be slow without being wedged. */
const PROBE_TIMEOUT_MS = 3000;

/** Whole check. Past this we stop probing and use what we have. */
const OVERALL_BUDGET_MS = 15000;

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), ms)),
  ]);
}

/** Minimal CDP client. Deliberately not Playwright: the point is to work when Playwright cannot. */
async function connect(cdpUrl) {
  // A refused connection is the clearest "there is no CDP here" there is, and it
  // was the one case that threw: withTimeout races, so a rejected fetch rejected
  // the race, past the !reachable branch that exists precisely for this. The
  // caller then logged "preflight failed" on every start of a machine whose
  // browser layer is not CDP at all. Catching turns it back into an answer.
  const res = await withTimeout(
    fetch(`${cdpUrl}/json/version`).then((r) => r.json()).catch(() => ({ unreachable: true })),
    5000,
  );
  if (res.timedOut || res.unreachable || !res.webSocketDebuggerUrl) return null;

  const ws = new WebSocket(res.webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 0;

  ws.onmessage = (m) => {
    const data = JSON.parse(m.data);
    if (data.id && pending.has(data.id)) {
      pending.get(data.id)(data);
      pending.delete(data.id);
    }
  };

  const opened = await withTimeout(new Promise((r) => { ws.onopen = () => r(true); }), 5000);
  if (opened.timedOut) { try { ws.close(); } catch {} return null; }

  const send = (method, params = {}, sessionId) =>
    new Promise((resolve) => {
      const id = ++nextId;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });

  return { send, close: () => { try { ws.close(); } catch {} } };
}

/**
 * Probe every target and report the ones that do not answer.
 *
 * `Runtime.enable` is the probe because it is what the real clients call and
 * what actually hangs. A target can attach fine and still never answer it, so
 * attaching alone proves nothing.
 */
export async function checkBrowserHealth({ cdpUrl = DEFAULT_CDP_URL } = {}) {
  const cdp = await connect(cdpUrl);
  if (!cdp) return { reachable: false, wedged: [], checked: 0 };

  const deadline = Date.now() + OVERALL_BUDGET_MS;
  const targets = await withTimeout(cdp.send('Target.getTargets'), 5000);
  if (targets.timedOut) { cdp.close(); return { reachable: false, wedged: [], checked: 0 };
  }

  const infos = targets.result?.targetInfos ?? [];
  const wedged = [];
  let checked = 0;

  const probes = infos.map(async (t) => {
    if (Date.now() > deadline) return;
    checked++;
    const attached = await withTimeout(
      cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true }),
      PROBE_TIMEOUT_MS,
    );
    if (attached.timedOut) { wedged.push(t); return; }

    const sessionId = attached.result?.sessionId;
    if (!sessionId) return;

    const enabled = await withTimeout(cdp.send('Runtime.enable', {}, sessionId), PROBE_TIMEOUT_MS);
    if (enabled.timedOut) wedged.push(t);
  });

  await Promise.all(probes);
  cdp.close();
  return { reachable: true, wedged, checked };
}

/**
 * Clear what is wedged: reload pages, close workers.
 *
 * A page is reloaded rather than closed because it is the user's tab and a
 * reload costs them nothing on the apps this actually happens to. A worker is
 * closed because there is nothing to reload and the site will make another.
 */
export async function healBrowser({ cdpUrl = DEFAULT_CDP_URL, log = console.warn } = {}) {
  const { reachable, wedged, checked } = await checkBrowserHealth({ cdpUrl });

  if (!reachable) {
    // Quiet by default. A machine whose browser layer is not CDP hits this on
    // every run and there is nothing to report; index.mjs skips the call
    // entirely in that case, so reaching here means CDP was expected.
    log?.('[browser-health] no CDP endpoint, skipping preflight');
    return { reachable: false, healed: 0 };
  }
  if (!wedged.length) return { reachable: true, healed: 0, checked };

  const cdp = await connect(cdpUrl);
  if (!cdp) return { reachable: false, healed: 0 };

  let healed = 0;
  for (const t of wedged) {
    const label = `${t.type} ${(t.title || t.url || '').slice(0, 60)}`;
    if (t.type === 'page') {
      const a = await withTimeout(
        cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true }),
        PROBE_TIMEOUT_MS,
      );
      if (a.timedOut || !a.result?.sessionId) continue;
      await withTimeout(cdp.send('Page.reload', { ignoreCache: false }, a.result.sessionId), PROBE_TIMEOUT_MS);
      log(`[browser-health] reloaded wedged ${label}`);
    } else {
      await withTimeout(cdp.send('Target.closeTarget', { targetId: t.targetId }), PROBE_TIMEOUT_MS);
      log(`[browser-health] closed wedged ${label}`);
    }
    healed++;
  }

  cdp.close();
  return { reachable: true, healed, checked };
}
