import test from 'node:test';
import assert from 'node:assert/strict';
import { fireKey, claimFire } from './routines.mjs';

// The old stamp was `now.toISOString().slice(0,13)` + `now.getMinutes()`: a UTC
// date-hour glued to LOCAL minutes. Identical on whole-hour offsets, wrong on
// +05:30, and wrong in a way that only shows up as a routine firing twice or
// not at all in one zone.

test('the key is one clock throughout', () => {
  assert.equal(fireKey(new Date('2026-09-09T11:38:42.171Z')), 'cron:2026-09-09T11:38Z');
});

test('the key is minute precision, so seconds within a tick collapse', () => {
  const a = fireKey(new Date('2026-09-09T11:38:00.000Z'));
  const b = fireKey(new Date('2026-09-09T11:38:59.999Z'));
  assert.equal(a, b);
});

test('a half-hour offset cannot change the key', () => {
  // Same instant, and the key must not depend on the machine's zone.
  const instant = new Date('2026-09-09T18:08:00.000Z');
  assert.equal(fireKey(instant), 'cron:2026-09-09T18:08Z');
});

test('the key comes from the scheduled instant, not from now', () => {
  // A tick that arrives late must produce the key of the minute it is FOR, so
  // a replay after a restart collides instead of firing again.
  const scheduled = new Date('2026-09-09T11:30:00.000Z');
  assert.equal(fireKey(scheduled), 'cron:2026-09-09T11:30Z');
});

test('claiming an unfired key succeeds and records it', () => {
  const { claimed, state } = claimFire({}, 'price-alerts', 'cron:2026-09-09T11:38Z');
  assert.equal(claimed, true);
  assert.equal(state['price-alerts'].lastFireKey, 'cron:2026-09-09T11:38Z');
});

test('claiming the same key twice fails the second time', () => {
  const first = claimFire({}, 'price-alerts', 'cron:2026-09-09T11:38Z');
  const second = claimFire(first.state, 'price-alerts', 'cron:2026-09-09T11:38Z');
  assert.equal(second.claimed, false);
});

test('a different minute claims again', () => {
  const first = claimFire({}, 'price-alerts', 'cron:2026-09-09T11:38Z');
  const second = claimFire(first.state, 'price-alerts', 'cron:2026-09-09T11:48Z');
  assert.equal(second.claimed, true);
});

test('routines do not block each other', () => {
  const first = claimFire({}, 'price-alerts', 'cron:2026-09-09T11:38Z');
  const second = claimFire(first.state, 'payout-check', 'cron:2026-09-09T11:38Z');
  assert.equal(second.claimed, true);
});

test('claiming does not mutate the state it was given', () => {
  // The caller persists the returned state before spawning. Mutating in place
  // would make "claimed but not yet durable" indistinguishable from "durable".
  const before = {};
  claimFire(before, 'price-alerts', 'cron:2026-09-09T11:38Z');
  assert.deepEqual(before, {});
});

test('claiming keeps whatever else the routine had recorded', () => {
  const state = { 'price-alerts': { lastRun: '2026-09-08T00:00:00Z', ok: true } };
  const { state: next } = claimFire(state, 'price-alerts', 'cron:2026-09-09T11:38Z');
  assert.equal(next['price-alerts'].lastRun, '2026-09-08T00:00:00Z');
  assert.equal(next['price-alerts'].ok, true);
});

// --- what an unattended routine is allowed to hold --------------------------

import { routineGrant, ROUTINE_BASE } from './routines.mjs';
import { mkdtemp as mkdtemp2, writeFile as writeFile2 } from 'node:fs/promises';
import { tmpdir as tmpdir2 } from 'node:os';
import { join as join2 } from 'node:path';

async function configWith(servers) {
  const p = join2(await mkdtemp2(join2(tmpdir2(), 'grant-')), 'mcp.json');
  await writeFile2(p, JSON.stringify({ mcpServers: servers }));
  return p;
}

test('a routine is not granted Bash, and is refused it outright', async () => {
  // The only scheduled run so far made zero Bash calls. Unattended runs read
  // live pages with nobody checking before they act.
  const { allowed, denied } = await routineGrant(await configWith({ aside: {}, memory: {} }));
  assert.equal(allowed.includes('Bash'), false);
  assert.ok(denied.includes('Bash'));
  assert.equal(ROUTINE_BASE.includes('Bash'), false);
});

test('a routine cannot post to Slack even when the config offers it', async () => {
  const { allowed, denied } = await routineGrant(await configWith({ aside: {}, memory: {}, slack: {} }));
  assert.equal(allowed.includes('mcp__slack'), false);
  assert.ok(denied.includes('mcp__slack'));
});

test('a routine keeps its browser and memory', async () => {
  const { allowed } = await routineGrant(await configWith({ aside: {}, memory: {}, slack: {} }));
  assert.ok(allowed.includes('mcp__aside'));
  assert.ok(allowed.includes('mcp__memory'));
  assert.ok(allowed.includes('Edit(memory/routines/**)'), 'it still writes its own log line');
});

test('the arbitrary-script denials still apply to routines', async () => {
  const { denied } = await routineGrant(await configWith({ browser: {} }));
  assert.ok(denied.includes('mcp__browser__browser_run_code_unsafe'));
  assert.ok(denied.includes('mcp__brave__browser_run_code_unsafe'));
});

test('a routine may write only its own records, and nothing that loads as instructions', async () => {
  // Verified on a real run in a scratch workspace: skills/, memory/sites/ and
  // memory/agent/ refused, memory/routines/ and memory/episodic/ written.
  const { allowed, denied } = await routineGrant(await configWith({ aside: {} }));
  assert.equal(allowed.includes('Edit'), false, 'no blanket edit');
  assert.equal(allowed.includes('Write'), false, 'no blanket write');
  for (const p of ['skills/**', '.claude/**', 'memory/sites/**', 'memory/agent/**', 'memory/users/**', 'CLAUDE.md']) {
    assert.ok(denied.includes(`Edit(${p})`), p);
  }
});

test('routines do not run in acceptEdits, which would override the path list', async () => {
  const { ROUTINE_PERMISSION_MODE } = await import('./routines.mjs');
  assert.equal(ROUTINE_PERMISSION_MODE, 'default');
});

test('the routine prompt no longer sends findings into site notes', async () => {
  const src = await (await import('node:fs/promises')).readFile(new URL('./routines.mjs', import.meta.url), 'utf8');
  const prompt = src.slice(src.indexOf('function buildPrompt'), src.indexOf('function buildPrompt') + 3000);
  assert.equal(/relevant memory\/sites\/ page/.test(prompt), false);
  assert.match(prompt, /read-only to a routine/);
});
