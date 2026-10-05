/**
 * Pure helpers for the Linear relay. No Cloudflare APIs, so node --test runs them.
 *
 * The relay is the only public thing in this design. A request reaches an agent
 * that drives a logged-in browser, so every step fails closed: a bad signature,
 * a stale timestamp, an unknown author or a missing field drops the event.
 */

export const AGENTS = ['hammock', 'tara'];

/** Linear recommends rejecting a webhook more than a minute off our clock. */
export const MAX_SKEW_MS = 60_000;

export const ACTIVITY_TYPES = ['thought', 'response', 'error', 'elicitation'];

const enc = new TextEncoder();

export async function hmacHex(secret, body) {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(body)));
  return [...sig].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Same-length compare that does not stop at the first differing byte. */
export function safeEqual(a, b) {
  const x = enc.encode(String(a));
  const y = enc.encode(String(b));
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/**
 * Check a Linear webhook: the `Linear-Signature` header is a hex HMAC-SHA256 of
 * the raw body, and `webhookTimestamp` (ms) must be within a minute of now.
 *
 * @returns {Promise<{ok:true, payload:object} | {ok:false, reason:string}>}
 */
export async function verifyWebhook({ secret, rawBody, signature, now = Date.now() }) {
  if (!secret) return { ok: false, reason: 'no secret configured' };
  if (!signature) return { ok: false, reason: 'no signature' };
  const expected = await hmacHex(secret, rawBody);
  if (!safeEqual(expected, signature)) return { ok: false, reason: 'bad signature' };
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { ok: false, reason: 'not json' };
  }
  const ts = Number(payload?.webhookTimestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > MAX_SKEW_MS) {
    return { ok: false, reason: 'stale or missing timestamp' };
  }
  return { ok: true, payload };
}

/** Who caused this event: the session's creator, or the author of a follow-up. */
export function actorOf(payload) {
  if (payload?.action === 'prompted') {
    // A follow-up can come from anyone who can see the session, so the session
    // creator is the wrong person to check. No author on the activity means
    // unknown, and unknown is refused.
    const a = payload.agentActivity;
    return a?.userId ?? a?.user?.id ?? null;
  }
  return payload?.agentSession?.creator?.id ?? null;
}

/**
 * Decide whether an event may reach an agent, and flatten it to what the
 * bridge needs.
 *
 * @returns {{ok:true, event:object} | {ok:false, reason:string}}
 */
export function gate(payload, { allowedUser, now = Date.now() } = {}) {
  if (!allowedUser) return { ok: false, reason: 'ALLOWED_LINEAR_USER is not set' };
  if (payload?.type !== 'AgentSessionEvent') return { ok: false, reason: `ignored type ${payload?.type}` };
  if (payload.action !== 'created' && payload.action !== 'prompted') {
    return { ok: false, reason: `ignored action ${payload.action}` };
  }
  const session = payload.agentSession;
  if (!session?.id) return { ok: false, reason: 'no session id' };
  const actor = actorOf(payload);
  if (!actor) return { ok: false, reason: 'no author on the event' };
  if (actor !== allowedUser) return { ok: false, reason: 'author is not the operator' };

  const activity = payload.agentActivity;

  // The session's comment can be a thread's root, written by someone else, and
  // the creator check above says nothing about it. It is his request only when
  // the comment's own author is him; otherwise it is context like the rest.
  let request = '';
  let promptContext = String(payload.promptContext ?? '');
  if (payload.action === 'prompted') {
    request = String(activity?.content?.body ?? '');
  } else {
    const comment = session.comment;
    const body = String(comment?.body ?? '');
    const author = comment?.userId ?? comment?.user?.id ?? null;
    if (body && author === allowedUser) {
      request = body;
    } else if (body) {
      promptContext = `Comment that started this session (author not confirmed as the operator):\n${body}\n\n${promptContext}`;
    }
  }

  return {
    ok: true,
    event: {
      receivedAt: now,
      action: payload.action,
      sessionId: session.id,
      issue: session.issue
        ? {
            identifier: session.issue.identifier ?? null,
            title: session.issue.title ?? null,
            url: session.issue.url ?? null,
          }
        : null,
      // The words he typed: a comment verified as his, or the follow-up prompt.
      request,
      signal: activity?.signal ?? null,
      // Everyone's words about the issue. The bridge fences this as data.
      promptContext,
    },
  };
}

/** Parse /hook/<agent>, /pull/<agent> or /activity/<agent>. */
export function route(method, pathname) {
  const m = /^\/(hook|pull|activity)\/([a-z]+)$/.exec(pathname);
  if (!m || !AGENTS.includes(m[2])) return null;
  const [, kind, agent] = m;
  const want = { hook: 'POST', pull: 'GET', activity: 'POST' }[kind];
  if (method !== want) return { kind, agent, methodNotAllowed: true };
  return { kind, agent };
}

/** The Authorization header's bearer token, or null. */
export function bearer(header) {
  const m = /^Bearer (.+)$/.exec(header || '');
  return m ? m[1] : null;
}

/** What `/activity` may post. Returns an error string, or null when fine. */
export function checkActivity(body) {
  if (!body || typeof body !== 'object') return 'body must be an object';
  if (typeof body.agentSessionId !== 'string' || !body.agentSessionId) return 'agentSessionId required';
  if (!ACTIVITY_TYPES.includes(body.type)) return `type must be one of ${ACTIVITY_TYPES.join(', ')}`;
  if (typeof body.body !== 'string' || !body.body.trim()) return 'body text required';
  return null;
}
