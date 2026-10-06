#!/usr/bin/env node
/**
 * Keep an agent's file tools inside the folders it is allowed to see.
 *
 * Claude Code has no allowlist for reads: a deny rule beats an allow rule, so
 * "read only under A1C" cannot be written as permission rules. This runs as a
 * PreToolUse hook and does it in code instead. It fails closed: any error, a
 * path it cannot resolve, or a config it cannot read blocks the call.
 *
 * Usage in settings: node path-fence-hook.mjs /path/to/fence.json
 *
 * Config (all paths absolute, `~` allowed):
 *   readRoots        folders reads may touch
 *   writeRoots       folders writes may touch (Write, Edit, MultiEdit, NotebookEdit)
 *   deny             never readable or writable, even inside a root
 *   allowInsideDeny  exceptions to `deny`, for reads only
 *   readOnly         inside a write root, but never writable
 *   denyNames        regexes matched against the file name
 *   denyTools        tool names blocked outright, such as Bash
 *   grepExclude      globs added to every Grep, so a search cannot print lines out of a
 *                    secrets file that a Read would have refused
 *
 * Compared lowercase and after realpath: macOS volumes are case-insensitive by
 * default, and a symlink must not carry a path out of its root.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, basename, isAbsolute, join, resolve } from 'node:path';

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead']);
const SEARCH_TOOLS = new Set(['Glob', 'Grep', 'LS']);

const expand = (p) => (p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : p);

/** realpath that also works for a file that does not exist yet. */
export function real(p) {
  let cur = resolve(p);
  const tail = [];
  for (;;) {
    try {
      return join(realpathSync.native(cur), ...tail.reverse()).toLowerCase();
    } catch {
      const up = dirname(cur);
      if (up === cur) return resolve(p).toLowerCase();
      tail.push(basename(cur));
      cur = up;
    }
  }
}

const inside = (p, root) => p === root || p.startsWith(`${root}/`);

/** True when the bridge says a teammate, not the operator, asked for this turn. */
const isTeamTurn = () => process.env.AGENT_REQUESTER_ROLE === 'team';

export function loadConfig(text) {
  const c = JSON.parse(text);
  const list = (k) => (c[k] || []).map((p) => real(expand(p)));
  return {
    readRoots: list('readRoots'),
    writeRoots: list('writeRoots'),
    deny: list('deny'),
    allowInsideDeny: list('allowInsideDeny'),
    readOnly: list('readOnly'),
    denyNames: (c.denyNames || []).map((r) => new RegExp(r, 'i')),
    denyTools: new Set(c.denyTools || []),
    grepExclude: c.grepExclude || [],
    // Refused only on a teammate's turn (AGENT_REQUESTER_ROLE=team, set by the
    // bridge). Unset means the operator, so nothing changes for him.
    teamDeny: list('teamDeny'),
    teamGrepExclude: c.teamGrepExclude || [],
  };
}

/** The paths a tool call would touch, or null when it names none. */
function pathsOf(tool, input, cwd) {
  const out = [];
  const add = (p) => {
    if (typeof p !== 'string' || !p) return;
    const e = expand(p);
    out.push(isAbsolute(e) ? e : resolve(cwd, e));
  };
  add(input.file_path);
  add(input.notebook_path);
  add(input.path);
  if (tool === 'Glob' && typeof input.pattern === 'string') {
    // An absolute or climbing pattern names a place of its own.
    const pat = expand(input.pattern);
    // Braces expand before matching, so `{..,x}` or `.{.,}` spell a '..' that no
    // segment shows. Wildcards cannot, since directory listings never hold '..'.
    if (/\{[^}]*[./][^}]*\}/.test(pat)) {
      throw new Error('a Glob pattern may not put a dot or slash inside braces');
    }
    const segs = pat.split('/');
    if (isAbsolute(pat) || segs.includes('..')) {
      // A wildcard before a '..' hides where the pattern ends up
      // (`*/../../x/**`), so no base can be derived from it: fail closed.
      if (segs.slice(0, segs.lastIndexOf('..') + 1).some((s) => /[*?[\]{}]/.test(s))) {
        throw new Error('a Glob pattern may not climb through a wildcard');
      }
      const base = pat.split(/[*?[{]/)[0];
      // Relative to `path` when given, since that is where Glob starts.
      const from = typeof input.path === 'string' && input.path ? resolve(cwd, expand(input.path)) : cwd;
      add(resolve(from, base.endsWith('/') ? base : dirname(base)));
    }
  }
  if (SEARCH_TOOLS.has(tool) && out.length === 0) out.push(cwd);
  return out;
}

/** A reason to block this call, or null to allow it. */
export function check(event, cfg) {
  const tool = event.tool_name;
  if (cfg.denyTools.has(tool)) return `${tool} is not available in this workspace.`;
  const write = WRITE_TOOLS.has(tool);
  if (!write && !READ_TOOLS.has(tool)) return null;

  const cwd = event.cwd || process.cwd();
  for (const raw of pathsOf(tool, event.tool_input || {}, cwd)) {
    const p = real(raw);
    const shown = raw.length > 80 ? `${raw.slice(0, 77)}...` : raw;
    if (cfg.denyNames.some((r) => r.test(basename(p)))) return `${shown} looks like a secrets file.`;
    if (isTeamTurn() && cfg.teamDeny.some((d) => inside(p, d))) {
      return `${shown} is not available for requests from teammates. Ask Rafli.`;
    }
    const denied = cfg.deny.some((d) => inside(p, d));
    if (denied && (write || !cfg.allowInsideDeny.some((a) => inside(p, a)))) {
      return `${shown} is outside what this agent may access.`;
    }
    const roots = write ? cfg.writeRoots : cfg.readRoots;
    if (!roots.some((r) => inside(p, r))) {
      return `${shown} is outside what this agent may ${write ? 'write' : 'read'}.`;
    }
    if (write && cfg.readOnly.some((r) => inside(p, r))) return `${shown} is read-only.`;
    // A search walks everything below it, so it must not start above a denied folder.
    if (SEARCH_TOOLS.has(tool)) {
      const hidden = cfg.deny.find((d) => inside(d, p) && d !== p);
      if (hidden) return `${shown} contains folders this agent may not search. Narrow the path.`;
    }
  }
  return null;
}

const deny = (reason) => ({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
});

/**
 * Grep reads inside files, and its Read-by-name check never sees them: a search
 * for "KEY" in a repo would print lines out of its .env. So every Grep is
 * rewritten to carry the exclusion globs from the config (`!**\/.env*` and the
 * like), added to whatever glob the agent asked for.
 */
export function rewrite(event, cfg) {
  if (event.tool_name !== 'Grep') return null;
  // A search reads inside files, so a teammate's turn also excludes the files
  // check() would have refused by name.
  const excludes = [...cfg.grepExclude, ...(isTeamTurn() ? cfg.teamGrepExclude : [])];
  if (excludes.length === 0) return null;
  const input = event.tool_input || {};
  const glob = [input.glob, ...excludes].filter(Boolean).join(' ');
  return {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { ...input, glob } },
  };
}

async function main() {
  let out = null;
  try {
    const cfg = loadConfig(readFileSync(process.argv[2], 'utf8'));
    let raw = '';
    for await (const chunk of process.stdin) raw += chunk;
    const event = JSON.parse(raw);
    const reason = check(event, cfg);
    out = reason ? deny(reason) : rewrite(event, cfg);
  } catch (err) {
    out = deny(`path fence could not decide (${err.message}); blocked.`);
  }
  if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
