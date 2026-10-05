/**
 * Cloudflare Worker: the public end of the Linear agent relay.
 *
 *   Linear --webhook--> POST /hook/<agent>      verify, gate, queue, ack
 *   bridge --poll-----> GET  /pull/<agent>      take the oldest queued event
 *   bridge --reply----> POST /activity/<agent>  write an activity to the session
 *
 * The bridges only ever call out, so nothing on the Mac listens. The Worker
 * holds the Linear credentials; a bridge holds one pull token and never sees them.
 *
 * Secrets per agent (A = HAMMOCK or TARA), set with `wrangler secret put`:
 *   WEBHOOK_SECRET_A  signing secret Linear shows on the app's webhook
 *   PULL_TOKEN_A      shared with that agent's bridge
 *   CLIENT_ID_A, CLIENT_SECRET_A   the Linear OAuth app, for client_credentials
 * Var: ALLOWED_LINEAR_USER, the one Linear user id whose events are accepted.
 */

import { verifyWebhook, gate, route, bearer, safeEqual, checkActivity } from './relay.mjs';
import { runAction, ActionError } from './linear-api.mjs';

const LINEAR_GRAPHQL = 'https://api.linear.app/graphql';
const LINEAR_TOKEN = 'https://api.linear.app/oauth/token';
const QUEUE_TTL_S = 60 * 60;
/** More than twice the 60 second skew window. KV will not take under 60. */
const SEEN_TTL_S = 180;
const TOKEN_TTL_S = 29 * 24 * 60 * 60;
const MAX_BODY = 256 * 1024;

const json = (status, obj) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

/** An app-actor token from the client_credentials grant, cached in KV. */
async function linearToken(env, agent, { fresh = false } = {}) {
  const A = agent.toUpperCase();
  const cacheKey = `tok:${agent}`;
  if (!fresh) {
    const cached = await env.QUEUE.get(cacheKey);
    if (cached) return cached;
  }
  const res = await fetch(LINEAR_TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      scope: 'read,write,app:assignable,app:mentionable',
      client_id: env[`CLIENT_ID_${A}`] ?? '',
      client_secret: env[`CLIENT_SECRET_${A}`] ?? '',
    }),
  });
  if (!res.ok) throw new Error(`token request failed: ${res.status}`);
  const { access_token: token } = await res.json();
  if (!token) throw new Error('token response had no access_token');
  await env.QUEUE.put(cacheKey, token, { expirationTtl: TOKEN_TTL_S });
  return token;
}

/** Write one activity to an agent session. Retries once on a 401 with a new token. */
async function postActivity(env, agent, { agentSessionId, type, body }) {
  const query =
    'mutation($input: AgentActivityCreateInput!){ agentActivityCreate(input: $input){ success } }';
  const variables = { input: { agentSessionId, content: { type, body } } };
  for (const fresh of [false, true]) {
    const token = await linearToken(env, agent, { fresh });
    const res = await fetch(LINEAR_GRAPHQL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ query, variables }),
    });
    if (res.status === 401 && !fresh) continue;
    const out = await res.json().catch(() => ({}));
    if (!res.ok || out.errors?.length || !out.data?.agentActivityCreate?.success) {
      throw new Error(`activity failed: ${res.status} ${JSON.stringify(out.errors ?? out).slice(0, 300)}`);
    }
    return;
  }
}

/** GraphQL as the agent's app user. One retry with a fresh token on a 401. */
function gqlFor(env, agent) {
  return async (query, variables) => {
    for (const fresh of [false, true]) {
      const token = await linearToken(env, agent, { fresh });
      const res = await fetch(LINEAR_GRAPHQL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ query, variables }),
      });
      if (res.status === 401 && !fresh) continue;
      const out = await res.json().catch(() => ({}));
      if (!res.ok || out.errors?.length) {
        throw new Error(`linear ${res.status} ${JSON.stringify(out.errors ?? out).slice(0, 300)}`);
      }
      return out.data;
    }
  };
}

/** The allowlisted Linear actions. See linear-api.mjs for what is and is not on the list. */
async function linearAction(request, env, agent) {
  const raw = await request.text();
  if (raw.length > MAX_BODY) return json(413, { error: 'too large' });
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(400, { error: 'not json' });
  }
  try {
    const result = await runAction(body?.action, body?.args, gqlFor(env, agent), { requester: body?.requester });
    return json(200, { ok: true, result });
  } catch (err) {
    if (err instanceof ActionError) return json(400, { ok: false, error: err.message });
    // The detail stays in the Worker log: it can carry Linear's own wording.
    console.log(`[${agent}] linear action ${String(body?.action).slice(0, 30)} failed: ${err.message}`);
    return json(502, { ok: false, error: 'Linear refused or failed that request. Check the arguments and try once more.' });
  }
}

async function hook(request, env, ctx, agent) {
  const rawBody = await request.text();
  if (rawBody.length > MAX_BODY) return json(413, { error: 'too large' });

  const A = agent.toUpperCase();
  const checked = await verifyWebhook({
    secret: env[`WEBHOOK_SECRET_${A}`],
    rawBody,
    signature: request.headers.get('linear-signature'),
  });
  if (!checked.ok) {
    console.log(`[${agent}] rejected: ${checked.reason}`);
    return json(401, { error: 'rejected' });
  }

  // The timestamp window is a minute, so a captured request could be replayed
  // inside it. The signature is unique to the body, so remember it for longer
  // than the window and refuse a second sighting. KV is eventually consistent,
  // which closes the common replay and not a perfectly simultaneous pair.
  const seenKey = `seen:${request.headers.get('linear-signature')}`;
  if (await env.QUEUE.get(seenKey)) {
    console.log(`[${agent}] dropped: replay`);
    return json(200, { ok: true, queued: false });
  }
  await env.QUEUE.put(seenKey, '1', { expirationTtl: SEEN_TTL_S });

  const verdict = gate(checked.payload, {
    allowedUser: env.ALLOWED_LINEAR_USER,
    // Per agent, so one agent can be open to the team while another stays operator-only.
    teamUsers: env[`TEAM_LINEAR_USERS_${A}`],
  });
  if (!verdict.ok) {
    // Still 200: Linear retries on anything else, and a refusal is final.
    console.log(`[${agent}] dropped: ${verdict.reason}`);
    return json(200, { ok: true, queued: false });
  }

  const event = { ...verdict.event, id: crypto.randomUUID() };
  await writeQueue(env, agent, [...(await readQueue(env, agent)), event]);

  // Linear wants a thought within 10 seconds or the session shows as dead. A
  // bridge polls every few seconds but may be asleep, so the Worker says it.
  if (event.signal !== 'stop') {
    ctx.waitUntil(
      postActivity(env, agent, {
        agentSessionId: event.sessionId,
        type: 'thought',
        body: 'Got it. Working on this now.',
      }).catch((err) => console.log(`[${agent}] ack failed: ${err.message}`)),
    );
  }
  return json(200, { ok: true, queued: true });
}

/** The queue is one small key per agent, so a poll is a single KV get. */
const headKey = (agent) => `head:${agent}`;

async function readQueue(env, agent) {
  const raw = await env.QUEUE.get(headKey(agent));
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    const cutoff = Date.now() - QUEUE_TTL_S * 1000;
    return Array.isArray(list) ? list.filter((e) => e && e.receivedAt >= cutoff) : [];
  } catch {
    return [];
  }
}

async function writeQueue(env, agent, list) {
  if (list.length) await env.QUEUE.put(headKey(agent), JSON.stringify(list), { expirationTtl: QUEUE_TTL_S });
  else await env.QUEUE.delete(headKey(agent));
}

async function pull(env, agent) {
  // A get per poll, not a list: the free plan allows 1,000 list calls a day and
  // two bridges polling every 5 seconds make 34,000.
  const queued = await readQueue(env, agent);
  const first = queued[0];
  if (!first) return json(200, { events: [] });
  // Taken before it is handed over: at most once, so a crashed bridge drops an
  // event instead of replaying an action in a logged-in browser. Re-read just
  // before writing, so an event that arrived a moment ago is not lost.
  const now = await readQueue(env, agent);
  await writeQueue(env, agent, now.filter((e) => e.id !== first.id));
  return json(200, { events: [first] });
}

async function activity(request, env, agent) {
  const text = await request.text();
  if (text.length > MAX_BODY) return json(413, { error: 'too large' });
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return json(400, { error: 'not json' });
  }
  const problem = checkActivity(body);
  if (problem) return json(400, { error: problem });
  try {
    await postActivity(env, agent, {
      agentSessionId: body.agentSessionId,
      type: body.type,
      body: body.body.slice(0, 9000),
    });
  } catch (err) {
    return json(502, { error: err.message });
  }
  return json(200, { ok: true });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const r = route(request.method, url.pathname);
    if (!r) return json(404, { error: 'not found' });
    if (r.methodNotAllowed) return json(405, { error: 'method not allowed' });

    if (r.kind === 'hook') return hook(request, env, ctx, r.agent);

    // pull and activity are the bridge's, behind its token.
    const token = bearer(request.headers.get('authorization'));
    const want = env[`PULL_TOKEN_${r.agent.toUpperCase()}`];
    if (!token || !want || !safeEqual(token, want)) return json(401, { error: 'unauthorized' });
    if (r.kind === 'pull') return pull(env, r.agent);
    if (r.kind === 'linear') return linearAction(request, env, r.agent);
    return activity(request, env, r.agent);
  },
};
