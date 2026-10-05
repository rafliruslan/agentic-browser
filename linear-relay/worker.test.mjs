import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import worker from './src/index.mjs';

const ME = 'user-rafli';

/** The slice of Workers KV the relay uses, in memory. */
function fakeKV() {
  const m = new Map();
  return {
    m,
    async get(k) { return m.get(k) ?? null; },
    async put(k, v) { m.set(k, v); },
    async delete(k) { m.delete(k); },
    async list() { throw new Error('list() is over quota on the free plan; the relay must not call it'); },
    async _unusedList({ prefix, limit }) {
      return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).sort().slice(0, limit).map((name) => ({ name })) };
    },
  };
}

const makeEnv = () => ({
  QUEUE: fakeKV(),
  ALLOWED_LINEAR_USER: ME,
  WEBHOOK_SECRET_HAMMOCK: 'whsec',
  PULL_TOKEN_HAMMOCK: 'pull-me',
  CLIENT_ID_HAMMOCK: 'cid',
  CLIENT_SECRET_HAMMOCK: 'csec',
});

function stubLinear() {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/oauth/token')) {
      return new Response(JSON.stringify({ access_token: 'app-token' }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: { agentActivityCreate: { success: true } } }), { status: 200 });
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

const ctx = () => {
  const pending = [];
  return { pending, waitUntil: (p) => pending.push(p) };
};

function signed(payload, secret = 'whsec') {
  const raw = JSON.stringify({ webhookTimestamp: Date.now(), ...payload });
  return new Request('https://relay.test/hook/hammock', {
    method: 'POST',
    body: raw,
    headers: { 'linear-signature': createHmac('sha256', secret).update(raw).digest('hex') },
  });
}

const session = (creator = ME) => ({
  type: 'AgentSessionEvent',
  action: 'created',
  promptContext: 'ctx',
  agentSession: { id: 'sess-1', creator: { id: creator }, issue: { identifier: 'PE-1', title: 't', url: 'u' }, comment: { body: 'hi' } },
});

const pullReq = (token = 'pull-me', agent = 'hammock') =>
  new Request(`https://relay.test/pull/${agent}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });

test('webhook -> queue -> thought ack -> pull once -> activity', async () => {
  const env = makeEnv();
  const linear = stubLinear();
  try {
    const c = ctx();
    const res = await worker.fetch(signed(session()), env, c);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, queued: true });
    await Promise.all(c.pending);

    // The ack: a token was minted with client_credentials, then a thought was posted.
    assert.match(linear.calls[0].url, /oauth\/token/);
    assert.match(String(linear.calls[0].init.body), /grant_type=client_credentials/);
    const gql = JSON.parse(linear.calls[1].init.body);
    assert.equal(linear.calls[1].init.headers.authorization, 'Bearer app-token');
    assert.deepEqual(gql.variables.input.content.type, 'thought');
    assert.equal(gql.variables.input.agentSessionId, 'sess-1');

    const first = await (await worker.fetch(pullReq(), env, ctx())).json();
    assert.equal(first.events.length, 1);
    assert.equal(first.events[0].sessionId, 'sess-1');
    const second = await (await worker.fetch(pullReq(), env, ctx())).json();
    assert.deepEqual(second.events, []);

    const post = await worker.fetch(
      new Request('https://relay.test/activity/hammock', {
        method: 'POST',
        headers: { authorization: 'Bearer pull-me' },
        body: JSON.stringify({ agentSessionId: 'sess-1', type: 'response', body: 'done' }),
      }),
      env,
      ctx(),
    );
    assert.equal(post.status, 200);
    // The cached token is reused: no second mint.
    assert.equal(linear.calls.filter((x) => /oauth\/token/.test(x.url)).length, 1);
    assert.equal(JSON.parse(linear.calls.at(-1).init.body).variables.input.content.body, 'done');
  } finally {
    linear.restore();
  }
});

test('the same signed request twice queues once', async () => {
  const env = makeEnv();
  const linear = stubLinear();
  try {
    const raw = JSON.stringify({ webhookTimestamp: Date.now(), ...session() });
    const sig = createHmac('sha256', 'whsec').update(raw).digest('hex');
    const send = () =>
      worker.fetch(
        new Request('https://relay.test/hook/hammock', { method: 'POST', body: raw, headers: { 'linear-signature': sig } }),
        env,
        ctx(),
      );
    assert.deepEqual(await (await send()).json(), { ok: true, queued: true });
    assert.deepEqual(await (await send()).json(), { ok: true, queued: false });
    assert.equal(JSON.parse(env.QUEUE.m.get('head:hammock') ?? '[]').length, 1);
  } finally {
    linear.restore();
  }
});

test('a bad signature is 401 and nothing is queued', async () => {
  const env = makeEnv();
  const res = await worker.fetch(signed(session(), 'wrong-secret'), env, ctx());
  assert.equal(res.status, 401);
  assert.equal(env.QUEUE.m.size, 0);
});

test('a valid event from someone else is 200 but dropped, with no ack', async () => {
  const env = makeEnv();
  const linear = stubLinear();
  try {
    const c = ctx();
    const res = await worker.fetch(signed(session('stranger')), env, c);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, queued: false });
    await Promise.all(c.pending);
    assert.equal(env.QUEUE.m.get('head:hammock'), undefined);
    assert.equal(linear.calls.length, 0);
  } finally {
    linear.restore();
  }
});

test('pull and activity need the agent token, and tokens are per agent', async () => {
  const env = makeEnv();
  assert.equal((await worker.fetch(pullReq(null), env, ctx())).status, 401);
  assert.equal((await worker.fetch(pullReq('nope'), env, ctx())).status, 401);
  // Tara has no token configured, so even a right-looking one is refused.
  assert.equal((await worker.fetch(pullReq('pull-me', 'tara'), env, ctx())).status, 401);
  const act = await worker.fetch(
    new Request('https://relay.test/activity/hammock', { method: 'POST', body: '{}' }),
    env,
    ctx(),
  );
  assert.equal(act.status, 401);
});

test('a bad activity body is 400, unknown paths 404, wrong method 405', async () => {
  const env = makeEnv();
  const bad = await worker.fetch(
    new Request('https://relay.test/activity/hammock', {
      method: 'POST',
      headers: { authorization: 'Bearer pull-me' },
      body: JSON.stringify({ agentSessionId: 's', type: 'action', body: 'x' }),
    }),
    env,
    ctx(),
  );
  assert.equal(bad.status, 400);
  assert.equal((await worker.fetch(new Request('https://relay.test/elsewhere'), env, ctx())).status, 404);
  assert.equal((await worker.fetch(new Request('https://relay.test/pull/hammock', { method: 'POST' }), env, ctx())).status, 405);
});

test('a 401 from Linear mints a fresh token and retries once', async () => {
  const env = makeEnv();
  await env.QUEUE.put('tok:hammock', 'stale');
  const real = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push(String(url));
    if (String(url).endsWith('/oauth/token')) return new Response(JSON.stringify({ access_token: 'fresh' }), { status: 200 });
    if (init.headers.authorization === 'Bearer stale') return new Response('{}', { status: 401 });
    return new Response(JSON.stringify({ data: { agentActivityCreate: { success: true } } }), { status: 200 });
  };
  try {
    const res = await worker.fetch(
      new Request('https://relay.test/activity/hammock', {
        method: 'POST',
        headers: { authorization: 'Bearer pull-me' },
        body: JSON.stringify({ agentSessionId: 's', type: 'response', body: 'x' }),
      }),
      env,
      ctx(),
    );
    assert.equal(res.status, 200);
    assert.equal(await env.QUEUE.get('tok:hammock'), 'fresh');
  } finally {
    globalThis.fetch = real;
  }
});
