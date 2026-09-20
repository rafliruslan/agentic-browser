import { readFile } from 'node:fs/promises';

/**
 * Which browser the agent drives is a property of the MCP config, not of this
 * code, so the tool allowlist is derived from that file rather than hardcoded.
 *
 * The bridge runs `claude -p --strict-mcp-config`, which loads only the file it
 * is handed and ignores everything else configured. So the servers named in
 * that file are, exactly, the servers that will exist. Deriving the allowlist
 * from the same source means the two can never drift, and swapping browsers is
 * a config edit rather than a patch.
 *
 * This is what lets one codebase serve two machines: Brave over CDP on Linux
 * (`brave`, `devtools`, `brave-repl`), Aside on macOS (`aside`). A hardcoded
 * `mcp__brave` list silently leaves the agent with no browser at all on the
 * other one, because --allowedTools is a whitelist: an unlisted tool is not
 * denied loudly, it is simply never offered.
 */

/** Tools the agent gets regardless of which browser is attached. */
export const BASE_TOOLS = [
  'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'WebFetch', 'WebSearch',
];

/**
 * `mcp__<server>` for every server in an MCP config object. The prefix form is
 * deliberate: it covers every tool a server exposes without this file needing
 * to track what those are.
 */
export function toolPrefixes(config) {
  const servers = config?.mcpServers;
  if (!servers || typeof servers !== 'object') return [];
  return Object.keys(servers)
    .filter((name) => typeof name === 'string' && name.length > 0)
    .map((name) => `mcp__${name}`);
}

/**
 * Read the MCP config and return the full allowlist.
 *
 * A missing or unreadable config is not fatal. The agent still has Read, Bash
 * and the rest, and it will say it cannot reach the browser, which is a far
 * better failure than refusing to start: the bridge is also how you would ask
 * it what went wrong.
 */
export async function browserPrefixes(path, { read = readFile, log = console.warn } = {}) {
  try {
    const prefixes = toolPrefixes(JSON.parse(await read(path, 'utf8')));
    if (prefixes.length === 0) log(`[browser] no mcpServers in ${path}; the agent will have no browser`);
    return prefixes;
  } catch (err) {
    log(`[browser] could not read ${path} (${err.message}); the agent will have no browser`);
    return [];
  }
}

/**
 * The browser plus a set of non-browser tools. `base` is a parameter because
 * routines.mjs deliberately runs narrower than the bridge does: an unattended
 * scheduled run has no one to sanity-check a web search, so it does not get one.
 */
export async function allowedTools(path, { base = BASE_TOOLS, ...opts } = {}) {
  return [...(await browserPrefixes(path, opts)), ...base];
}

/**
 * Flags by which an MCP server declares it drives a browser over CDP.
 * Playwright spells it one way, chrome-devtools-mcp another.
 */
const CDP_FLAGS = ['--cdp-endpoint', '--browserUrl'];

/**
 * The CDP endpoint this machine's browser layer uses, or null if it has none.
 *
 * Only a CDP browser can be preflighted for wedged targets, and only a CDP
 * browser can go wedged in that way. Aside is driven through its own process
 * and exposes no port, so probing one there fails on every single run and says
 * nothing. Reading the answer out of the same config that picks the browser
 * keeps this from becoming a second thing to remember.
 *
 * Returns the URL rather than a boolean so the check probes the port actually
 * configured, instead of assuming the default.
 */
export function cdpEndpoint(config) {
  const servers = config?.mcpServers;
  if (!servers || typeof servers !== 'object') return null;
  for (const server of Object.values(servers)) {
    const args = Array.isArray(server?.args) ? server.args : [];
    for (let i = 0; i < args.length; i++) {
      if (CDP_FLAGS.includes(args[i]) && typeof args[i + 1] === 'string') return args[i + 1];
    }
  }
  return null;
}

/** Read the config and report its CDP endpoint. Unreadable config means none. */
export async function browserCdpUrl(path, { read = readFile } = {}) {
  try {
    return cdpEndpoint(JSON.parse(await read(path, 'utf8')));
  } catch {
    return null;
  }
}

/**
 * Tool names that run arbitrary script, whatever the browser is called.
 *
 * These were denied by their literal names, `mcp__brave__browser_run_code_unsafe`
 * and `mcp__devtools__evaluate_script`. That held exactly as long as the server
 * was called `brave`: point the same Playwright MCP at Chromium under the key
 * `chromium` and the tool becomes `mcp__chromium__browser_run_code_unsafe`,
 * which no longer matches, and a door shut deliberately reopens without a word.
 *
 * So the names are derived from the config instead of written down. Every
 * configured server contributes its own spelling of both, and the two historical
 * literals are kept whether or not those servers exist: a machine whose config
 * this cannot read must not end up with a shorter denylist than before.
 */
export const UNSAFE_SUFFIXES = ['browser_run_code_unsafe', 'evaluate_script'];

const LEGACY_DENIED = ['mcp__brave__browser_run_code_unsafe', 'mcp__devtools__evaluate_script'];

export function unsafeTools(config) {
  const names = new Set(LEGACY_DENIED);
  const servers = config?.mcpServers;
  if (servers && typeof servers === 'object') {
    for (const server of Object.keys(servers)) {
      for (const suffix of UNSAFE_SUFFIXES) names.add(`mcp__${server}__${suffix}`);
    }
  }
  return [...names];
}

/** Read the config and list every arbitrary-script tool it could expose. */
export async function deniedBrowserTools(path, { read = readFile } = {}) {
  try {
    return unsafeTools(JSON.parse(await read(path, 'utf8')));
  } catch {
    // An unreadable config must not shorten the denylist.
    return [...LEGACY_DENIED];
  }
}
