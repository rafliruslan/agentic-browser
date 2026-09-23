import test from 'node:test';
import assert from 'node:assert/strict';
import { toolPrefixes, allowedTools, browserPrefixes, cdpEndpoint, browserCdpUrl, BASE_TOOLS } from './browser.mjs';

const BRAVE = { mcpServers: { browser: {}, devtools: {}, 'browser-repl': {} } };
const ASIDE = { mcpServers: { aside: {} } };

test('toolPrefixes names every server in the config', () => {
  assert.deepEqual(toolPrefixes(BRAVE), ['mcp__browser', 'mcp__devtools', 'mcp__browser-repl']);
});

// The whole point: the same code produces a different allowlist per machine.
test('toolPrefixes follows the config to a different browser', () => {
  assert.deepEqual(toolPrefixes(ASIDE), ['mcp__aside']);
});

test('toolPrefixes handles a config with no servers', () => {
  assert.deepEqual(toolPrefixes({ mcpServers: {} }), []);
  assert.deepEqual(toolPrefixes({}), []);
  assert.deepEqual(toolPrefixes(null), []);
  assert.deepEqual(toolPrefixes({ mcpServers: 'nope' }), []);
});

test('toolPrefixes ignores an empty server name', () => {
  assert.deepEqual(toolPrefixes({ mcpServers: { '': {}, browser: {} } }), ['mcp__browser']);
});

test('allowedTools appends the base tools after the browser', async () => {
  const read = async () => JSON.stringify(ASIDE);
  assert.deepEqual(await allowedTools('/x', { read }), ['mcp__aside', ...BASE_TOOLS]);
});

test('allowedTools reads the Brave layer whole', async () => {
  const read = async () => JSON.stringify(BRAVE);
  const tools = await allowedTools('/x', { read });
  assert.ok(tools.includes('mcp__browser'));
  assert.ok(tools.includes('mcp__devtools'));
  assert.ok(tools.includes('mcp__browser-repl'));
});

// Refusing to start would take away the very channel you would use to ask why.
test('allowedTools survives a missing config and still grants the base tools', async () => {
  const read = async () => { throw new Error('ENOENT'); };
  const said = [];
  assert.deepEqual(await allowedTools('/x', { read, log: (m) => said.push(m) }), BASE_TOOLS);
  assert.match(said[0], /no browser/);
});

test('allowedTools survives a corrupt config', async () => {
  const read = async () => 'not json';
  const said = [];
  assert.deepEqual(await allowedTools('/x', { read, log: (m) => said.push(m) }), BASE_TOOLS);
  assert.match(said[0], /could not read/);
});

// Silent is the failure mode that matters: --allowedTools is a whitelist, so an
// unlisted browser is never offered rather than loudly denied.
test('allowedTools warns when the config parses but names nothing', async () => {
  const read = async () => '{"mcpServers":{}}';
  const said = [];
  await allowedTools('/x', { read, log: (m) => said.push(m) });
  assert.match(said[0], /no mcpServers/);
});

test('Bash stays available so the agent can reach a CLI browser directly', () => {
  assert.ok(BASE_TOOLS.includes('Bash'));
});

// routines.mjs runs narrower than the bridge; the helper must not widen it.
test('allowedTools honours a narrower base list', async () => {
  const read = async () => JSON.stringify(ASIDE);
  const tools = await allowedTools('/x', { read, base: ['Read', 'Bash'] });
  assert.deepEqual(tools, ['mcp__aside', 'Read', 'Bash']);
  assert.ok(!tools.includes('WebSearch'));
});

test('browserPrefixes returns the browser half alone', async () => {
  const read = async () => JSON.stringify(BRAVE);
  assert.deepEqual(await browserPrefixes('/x', { read }), ['mcp__browser', 'mcp__devtools', 'mcp__browser-repl']);
});

// Caught during the port: config.example/mcp.json was written from the plugin's
// two servers and silently dropped browser-repl, which the hardcoded list had.
// --allowedTools is a whitelist, so that loses the diff-snapshot server with no
// error anywhere. The shipped Linux config must still name all three.
test('the shipped Linux config yields the tools the hardcoded list had', async () => {
  const tools = await allowedTools(new URL('./config.example/mcp.json', import.meta.url).pathname);
  for (const t of ['mcp__browser', 'mcp__devtools', 'mcp__browser-repl']) {
    assert.ok(tools.includes(t), `${t} missing from config.example/mcp.json`);
  }
});

test('the shipped macOS config attaches Aside', async () => {
  const tools = await allowedTools(new URL('./config.example/mcp.aside.json', import.meta.url).pathname);
  assert.ok(tools.includes('mcp__aside'));
  assert.ok(!tools.includes('mcp__browser'), 'the macOS layer must not also attach Brave');
});

// --- which browser layer, and therefore whether a CDP preflight makes sense ---

test('cdpEndpoint finds the Playwright endpoint', () => {
  assert.equal(cdpEndpoint({ mcpServers: { browser: { args: ['-y', 'x', '--cdp-endpoint', 'http://127.0.0.1:9222'] } } }), 'http://127.0.0.1:9222');
});

test('cdpEndpoint finds the chrome-devtools spelling too', () => {
  assert.equal(cdpEndpoint({ mcpServers: { devtools: { args: ['--browserUrl', 'http://127.0.0.1:9333'] } } }), 'http://127.0.0.1:9333');
});

// The whole reason this exists: Aside exposes no port, so probing one fails on
// every run and reports nothing.
test('cdpEndpoint returns null for a non-CDP browser layer', () => {
  assert.equal(cdpEndpoint({ mcpServers: { aside: { args: ['mcp'] } } }), null);
});

test('cdpEndpoint handles junk without throwing', () => {
  assert.equal(cdpEndpoint(null), null);
  assert.equal(cdpEndpoint({}), null);
  assert.equal(cdpEndpoint({ mcpServers: { a: {} } }), null);
  assert.equal(cdpEndpoint({ mcpServers: { a: { args: 'nope' } } }), null);
});

// A flag with nothing after it is a broken config, not an endpoint.
test('cdpEndpoint ignores a trailing flag with no value', () => {
  assert.equal(cdpEndpoint({ mcpServers: { a: { args: ['--cdp-endpoint'] } } }), null);
});

test('the shipped configs disagree about CDP, which is the point', async () => {
  const here = (f) => new URL(`./config.example/${f}`, import.meta.url).pathname;
  assert.equal(await browserCdpUrl(here('mcp.json')), 'http://127.0.0.1:9222');
  assert.equal(await browserCdpUrl(here('mcp.aside.json')), null);
});

test('browserCdpUrl treats an unreadable config as no CDP', async () => {
  assert.equal(await browserCdpUrl('/nope/mcp.json'), null);
});

// --- denying arbitrary script whatever the browser is called ----------------

import { unsafeTools, UNSAFE_SUFFIXES } from './browser.mjs';

test('a renamed browser server still has its script tools denied', () => {
  // The whole point. Denying the literal mcp__browser__* names held only while
  // the server was called brave; pointing the same Playwright MCP at Chromium
  // under another key reopened a door that was shut deliberately.
  const got = unsafeTools({ mcpServers: { chromium: { args: ['--cdp-endpoint', 'http://x'] } } });
  assert.ok(got.includes('mcp__chromium__browser_run_code_unsafe'));
  assert.ok(got.includes('mcp__chromium__evaluate_script'));
});

test('the historical names are kept even when those servers are absent', () => {
  // A machine whose config we cannot read must not end up with a shorter
  // denylist than it had before.
  const got = unsafeTools({ mcpServers: { chromium: {} } });
  assert.ok(got.includes('mcp__browser__browser_run_code_unsafe'));
  assert.ok(got.includes('mcp__devtools__evaluate_script'));
});

test('every configured server contributes its own spelling', () => {
  const got = unsafeTools({ mcpServers: { a: {}, b: {} } });
  for (const s of UNSAFE_SUFFIXES) {
    assert.ok(got.includes(`mcp__a__${s}`), `a/${s}`);
    assert.ok(got.includes(`mcp__b__${s}`), `b/${s}`);
  }
});

test('a junk config still denies the historical names', () => {
  for (const cfg of [null, {}, { mcpServers: 'nope' }]) {
    const got = unsafeTools(cfg);
    assert.ok(got.includes('mcp__browser__browser_run_code_unsafe'));
  }
});

test('no duplicates when the server really is called brave', () => {
  const got = unsafeTools({ mcpServers: { browser: {} } });
  assert.equal(got.filter((t) => t === 'mcp__browser__browser_run_code_unsafe').length, 1);
});

test('the pre-rename tool name stays denied, for machines not yet migrated', () => {
  // The Linux box still calls its server "brave". If the denylist only knew
  // the new spelling, arbitrary script would run there unblocked. A rename
  // script rewrote these values once and removed exactly this protection.
  const old = unsafeTools({ mcpServers: { brave: {} } });
  assert.ok(old.includes('mcp__brave__browser_run_code_unsafe'));
});

test('an unreadable config denies BOTH spellings, not just the current one', () => {
  for (const cfg of [null, {}, { mcpServers: 'nope' }]) {
    const got = unsafeTools(cfg);
    assert.ok(got.includes('mcp__brave__browser_run_code_unsafe'), 'pre-rename name');
    assert.ok(got.includes('mcp__browser__browser_run_code_unsafe'), 'current name');
  }
});
