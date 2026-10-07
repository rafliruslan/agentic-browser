# Memory Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every five minutes, each machine commits, merges and pushes the agents' memory stores (Hammock, Tara, Aside) through private git repos, without losing a change to a merge, a secret scan miss, or Aside rewriting a note mid-sync.

**Architecture:** A dependency-free Node CLI in `sync/` runs one pass and exits; launchd (macOS) or a systemd user timer (Linux) starts it. Each store is a git work tree, optionally with its git directory kept outside the work tree (Aside). A pass per store: Aside lost-update repair, stage, secret scan, commit, fetch, merge, push. A conflict stops only that store until `--resume`.

**Tech Stack:** Node 26 (ESM `.mjs`, `node:test`), git 2.56 via `child_process.spawnSync`. No npm dependencies.

**Spec:** `docs/superpowers/specs/2026-10-07-memory-sync-design.md`

## Global Constraints

- No npm dependencies in `sync/`. Node built-ins and the `git` binary only.
- Every store remote is a private repo. Nothing in `sync/` or its tests names a real account, repo URL, token or person.
- `sync/sync.config.json` is per machine and gitignored; `sync/sync.config.example.json` shows the shape.
- Commits made by the sync use author `agent-sync <agent-sync@<machine>>` and message `sync from <machine>`. No AI attribution anywhere.
- Merge, never rebase. `git merge --abort` on conflict; the work tree is left exactly as before the merge.
- A stopped store is recorded in `<stateDir>/stopped/<name>` and skipped until `sync.mjs --resume <name>`. One stopped store never blocks another.
- Network failures (fetch or push) never stop a store.
- State lives in `$XDG_STATE_HOME/agent-sync/` (default `~/.local/state/agent-sync/`).
- Nothing new is written inside an Aside memory folder except notes the merge or the repair changes. Aside's git dir, attributes and excludes live under `gitDir`.
- `**/episodic/*.md merge=union`, set in `<gitDir>/info/attributes`.
- Prose in code comments: plain, short, no em dashes.

## Review Focus

1. **A secret already in a note when the store is first set up.** The scan sees only staged added lines, so setup's first commit must be scanned too. Pinned in Task 7 (`prepareStore` scans before its first commit).
2. **Aside's run log is huge (590 MB) and grows while read.** The guard must never load it whole, must ignore a half-written last line, and must start from the end on first sight. Pinned in Task 4.
3. **The machine is offline for a day.** Fetch fails; the store must report `offline`, keep its local commits, and push them on the next good pass. Pinned in Task 5.
4. **A pass already running when the timer fires again** (slow network). The second pass must exit quietly. Pinned in Task 6.
5. **A note path with spaces or non-ASCII characters** (Aside names notes from titles). Diff parsing and `writesFromMerge` must handle it. Pinned in Tasks 2 and 5.

## File Structure

| File | Responsibility |
|---|---|
| `sync/git.mjs` | Run git for a store, with optional separate git dir. |
| `sync/config.mjs` | Parse and validate `sync.config.json`. |
| `sync/secrets.mjs` | Find token patterns in a staged diff's added lines. |
| `sync/state.mjs` | Stopped markers, per-store state, `status.json`, lock path. |
| `sync/aside-guard.mjs` | Read new Aside runs, find lost updates, three-way merge them. |
| `sync/store.mjs` | One pass for one store. |
| `sync/notify.mjs` | Desktop notification. |
| `sync/sync.mjs` | CLI: lock, pass over all stores, status, `--resume`. |
| `sync/setup.mjs` | Per machine: prepare repos, Tara's links, timer. |
| `sync/test-helpers.mjs` | Temp remotes and clones for tests. |
| `sync/sync.config.example.json` | Config shape. |

---

### Task 1: git runner and config

**Files:**
- Create: `sync/git.mjs`, `sync/config.mjs`, `sync/config.test.mjs`, `sync/sync.config.example.json`
- Modify: `.gitignore` (append)

**Interfaces:**
- Produces: `git(args, { cwd, gitDir, workTree, input, encoding }) -> { code, stdout, stderr }`; `storeGit(store) -> (args, opts?) => result`; `class GitError`; `expand(path, home)`; `loadConfig(text, { home }) -> { machine, intervalMinutes, stores: Store[] }` where `Store = { name, workTree, gitDir: string|null, remote, branch, mode: 'readwrite'|'pull', aside: boolean, relativeLinks: boolean }`.

- [ ] **Step 1: Write the failing test** `sync/config.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, expand } from './config.mjs';

const home = '/home/x';
const one = (store, extra = {}) => JSON.stringify({ machine: 'mac-a', stores: [store], ...extra });

test('expands ~ and fills defaults', () => {
  const c = loadConfig(one({ name: 'hammock', workTree: '~/m', remote: 'r' }), { home });
  assert.equal(c.machine, 'mac-a');
  assert.equal(c.intervalMinutes, 5);
  assert.deepEqual(c.stores[0], {
    name: 'hammock', workTree: '/home/x/m', gitDir: null, remote: 'r', branch: 'main',
    mode: 'readwrite', aside: false, relativeLinks: false,
  });
});

test('expands gitDir and keeps flags', () => {
  const c = loadConfig(one({ name: 'aside-u0', workTree: '~/a', gitDir: '~/g.git', remote: 'r', aside: true, mode: 'pull' }), { home });
  assert.equal(c.stores[0].gitDir, '/home/x/g.git');
  assert.equal(c.stores[0].aside, true);
  assert.equal(c.stores[0].mode, 'pull');
});

test('rejects bad input', () => {
  assert.throws(() => loadConfig(JSON.stringify({ stores: [] }), { home }), /non-empty/);
  assert.throws(() => loadConfig(one({ name: 'Bad Name', workTree: 'a', remote: 'r' }), { home }), /name/);
  assert.throws(() => loadConfig(one({ name: 'a', remote: 'r' }), { home }), /workTree/);
  assert.throws(() => loadConfig(one({ name: 'a', workTree: 'a' }), { home }), /remote/);
  assert.throws(() => loadConfig(one({ name: 'a', workTree: 'a', remote: 'r', mode: 'push' }), { home }), /mode/);
  const dup = JSON.stringify({ stores: [{ name: 'a', workTree: 'a', remote: 'r' }, { name: 'a', workTree: 'b', remote: 'r' }] });
  assert.throws(() => loadConfig(dup, { home }), /duplicate/);
  assert.throws(() => loadConfig(JSON.stringify({ intervalMinutes: 0, stores: [{ name: 'a', workTree: 'a', remote: 'r' }] }), { home }), /intervalMinutes/);
});

test('expand leaves other paths alone', () => {
  assert.equal(expand('~', home), '/home/x');
  assert.equal(expand('/abs', home), '/abs');
  assert.equal(expand('~other/x', home), '~other/x');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test sync/config.test.mjs`
Expected: FAIL, `Cannot find module` for `./config.mjs`.

- [ ] **Step 3: Implement** `sync/git.mjs`

```js
/**
 * Run git for one store. A store may keep its git directory outside its work
 * tree (Aside's notes), so both are passed through the environment rather
 * than assumed from the working directory.
 */
import { spawnSync } from 'node:child_process';

export class GitError extends Error {
  constructor(args, result) {
    super(`git ${args[0]} failed: ${String(result.stderr).trim().split('\n')[0]}`);
    this.result = result;
  }
}

export function git(args, { cwd, gitDir, workTree, input, encoding = 'utf8' } = {}) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  // Inherited values would point git at some other repo.
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  if (gitDir) env.GIT_DIR = gitDir;
  if (gitDir && workTree) env.GIT_WORK_TREE = workTree;
  const r = spawnSync('git', args, {
    cwd: workTree || cwd, env, input, encoding, maxBuffer: 512 * 1024 * 1024,
  });
  return {
    code: r.status ?? 1,
    stdout: r.stdout ?? (encoding === 'buffer' ? Buffer.alloc(0) : ''),
    stderr: String(r.stderr ?? (r.error ? r.error.message : '')),
  };
}

/** A git runner bound to one store. */
export const storeGit = (store) => (args, opts = {}) =>
  git(args, { gitDir: store.gitDir, workTree: store.workTree, ...opts });
```

- [ ] **Step 4: Implement** `sync/config.mjs`

```js
/** Parse and check `sync.config.json`. Paths may start with `~`. */
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';

export const expand = (p, home = homedir()) =>
  p === '~' || p.startsWith('~/') ? join(home, p.slice(1)) : p;

export function loadConfig(text, { home = homedir() } = {}) {
  const c = JSON.parse(text);
  if (!Array.isArray(c.stores) || c.stores.length === 0) {
    throw new Error('config: stores must be a non-empty list');
  }
  const interval = c.intervalMinutes ?? 5;
  if (!Number.isInteger(interval) || interval < 1) throw new Error('config: intervalMinutes must be a whole number of at least 1');
  const seen = new Set();
  const stores = c.stores.map((s, i) => {
    if (typeof s.name !== 'string' || !/^[a-z0-9-]+$/.test(s.name)) {
      throw new Error(`config: store ${i} needs a name of lowercase letters, digits and dashes`);
    }
    if (seen.has(s.name)) throw new Error(`config: duplicate store ${s.name}`);
    seen.add(s.name);
    if (!s.workTree) throw new Error(`config: store ${s.name} needs workTree`);
    if (!s.remote) throw new Error(`config: store ${s.name} needs remote`);
    const mode = s.mode ?? 'readwrite';
    if (mode !== 'readwrite' && mode !== 'pull') throw new Error(`config: store ${s.name} mode must be readwrite or pull`);
    return {
      name: s.name,
      workTree: expand(s.workTree, home),
      gitDir: s.gitDir ? expand(s.gitDir, home) : null,
      remote: s.remote,
      branch: s.branch ?? 'main',
      mode,
      aside: Boolean(s.aside),
      relativeLinks: Boolean(s.relativeLinks),
    };
  });
  return { machine: c.machine || hostname().split('.')[0], intervalMinutes: interval, stores };
}
```

- [ ] **Step 5: Create** `sync/sync.config.example.json`

```json
{
  "_linux": "On a machine without Aside, give the aside stores mode pull, no aside flag, and a workTree under ~/.local/share/agent-sync/.",
  "machine": "mac-a",
  "intervalMinutes": 5,
  "stores": [
    { "name": "hammock", "workTree": "~/Documents/A1C/agent/hammock-memory", "remote": "git@github.com:<you>/hammock-memory.git" },
    { "name": "tara", "workTree": "~/Documents/A1C/agent/tara-workspace", "remote": "git@github.com:<you>/tara-memory.git", "relativeLinks": true },
    { "name": "aside-u0", "workTree": "~/.aside/u/0/memory", "gitDir": "~/.local/share/agent-sync/aside-u0.git", "remote": "git@github.com:<you>/aside-memory-u0.git", "aside": true },
    { "name": "aside-u3", "workTree": "~/.aside/u/3/memory", "gitDir": "~/.local/share/agent-sync/aside-u3.git", "remote": "git@github.com:<you>/aside-memory-u3.git", "aside": true }
  ]
}
```

- [ ] **Step 6: Append to** `.gitignore`

```
# Per-machine memory sync config. sync/sync.config.example.json shows the shape.
/sync/sync.config.json
```

- [ ] **Step 7: Run tests, verify pass**

Run: `node --test sync/config.test.mjs`
Expected: 4 tests pass.

- [ ] **Step 8: Commit**

```bash
git add sync/git.mjs sync/config.mjs sync/config.test.mjs sync/sync.config.example.json .gitignore
git commit -m "Memory sync: git runner and config"
```

---

### Task 2: secret scan

**Files:**
- Create: `sync/secrets.mjs`, `sync/secrets.test.mjs`

**Interfaces:**
- Produces: `PATTERNS: [name, RegExp][]`; `scanText(text) -> string[]` (pattern names); `addedLines(diff) -> Map<file, string>`; `findSecrets(diff) -> { file, pattern }[]`. `diff` is the output of `git -c core.quotepath=false diff --cached -U0 --no-color`.

- [ ] **Step 1: Write the failing test** `sync/secrets.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanText, findSecrets, addedLines } from './secrets.mjs';

// Built at runtime so this file never holds a token-shaped string itself.
const fake = (prefix, n, ch = 'a') => prefix + ch.repeat(n);

test('each pattern fires on a token of its shape', () => {
  const cases = {
    'slack-token': fake('xoxb-', 30),
    'slack-app-token': fake('xapp-1-', 30),
    'anthropic-key': fake('sk-ant-', 40),
    'openai-key': fake('sk-proj-', 40),
    'github-token': fake('ghp_', 36),
    'gitlab-token': fake('glpat-', 20),
    'linear-key': fake('lin_api_', 40),
    'shopify-token': fake('shpat_', 32, 'f'),
    'aws-key': 'AKIA' + 'A'.repeat(16),
    'google-api-key': fake('AIza', 35),
    'private-key': '-----BEGIN OPENSSH ' + 'PRIVATE KEY-----',
  };
  for (const [name, value] of Object.entries(cases)) {
    assert.deepEqual(scanText(`x ${value} y`), [name], name);
  }
});

test('ordinary notes do not fire', () => {
  assert.deepEqual(scanText('Slack bot tokens start with xoxb- and the app token with xapp-.'), []);
  assert.deepEqual(scanText('sk-ant is the prefix; never paste the key.'), []);
});

const diff = (file, added, removed = []) => [
  `diff --git a/${file} b/${file}`,
  `--- a/${file}`,
  `+++ b/${file}`,
  '@@ -1 +1 @@',
  ...removed.map((l) => `-${l}`),
  ...added.map((l) => `+${l}`),
  '',
].join('\n');

test('reports file and pattern, never the value', () => {
  const token = fake('xoxb-', 30);
  const hits = findSecrets(diff('sites/app.slack.com.md', [`token: ${token}`]));
  assert.deepEqual(hits, [{ file: 'sites/app.slack.com.md', pattern: 'slack-token' }]);
  assert.ok(!JSON.stringify(hits).includes(token));
});

test('removed lines are not scanned', () => {
  assert.deepEqual(findSecrets(diff('a.md', ['clean'], [fake('xoxb-', 30)])), []);
});

test('paths with spaces and non-ASCII survive', () => {
  const m = addedLines(diff('projects/café notes.md', ['hi']));
  assert.deepEqual([...m.keys()], ['projects/café notes.md']);
});

test('a content line starting with ++ is content, not a header', () => {
  const d = diff('a.md', ['++ not a header', fake('ghp_', 36)]);
  assert.deepEqual(findSecrets(d), [{ file: 'a.md', pattern: 'github-token' }]);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test sync/secrets.test.mjs`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement** `sync/secrets.mjs`

```js
/**
 * Refuse to commit anything shaped like a credential. Only lines a commit adds
 * are scanned, and a hit is reported by file and pattern name: the matched
 * text never reaches a log, a notification or the status file.
 */
export const PATTERNS = [
  ['slack-token', /\bxox[abposre]-[A-Za-z0-9-]{10,}/],
  ['slack-app-token', /\bxapp-\d-[A-Za-z0-9-]{10,}/],
  ['anthropic-key', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['openai-key', /\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{32,}/],
  ['github-token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{40,}/],
  ['gitlab-token', /\bglpat-[A-Za-z0-9_-]{20,}/],
  ['linear-key', /\blin_(?:api|oauth)_[A-Za-z0-9]{30,}/],
  ['shopify-token', /\bshp(?:at|ca|pa|ss)_[a-f0-9]{32}/],
  ['aws-key', /\bAKIA[0-9A-Z]{16}\b/],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}/],
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];

export const scanText = (text) => PATTERNS.filter(([, re]) => re.test(text)).map(([name]) => name);

/** Added lines per file. Headers are recognised only between `diff --git` and the first `@@`. */
export function addedLines(diff) {
  const out = new Map();
  let file = null;
  let header = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) { header = true; file = null; continue; }
    if (header) {
      if (line.startsWith('+++ ')) file = line === '+++ /dev/null' ? null : line.slice(6);
      if (line.startsWith('@@')) header = false;
      continue;
    }
    if (file && line.startsWith('+')) out.set(file, `${out.get(file) ?? ''}${line.slice(1)}\n`);
  }
  return out;
}

export function findSecrets(diff) {
  const hits = [];
  for (const [file, text] of addedLines(diff)) {
    for (const pattern of scanText(text)) hits.push({ file, pattern });
  }
  return hits;
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `node --test sync/secrets.test.mjs`
Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add sync/secrets.mjs sync/secrets.test.mjs
git commit -m "Memory sync: refuse to commit token-shaped text"
```

---

### Task 3: state

**Files:**
- Create: `sync/state.mjs`, `sync/state.test.mjs`

**Interfaces:**
- Produces: `stateDir(env?, home?) -> string`; `createState(dir) -> { dir, lockPath, stopped(name) -> string|null, stop(name, reason), resume(name) -> boolean, store(name) -> object, saveStore(name, obj), status() -> object, saveStatus(obj) }`.

- [ ] **Step 1: Write the failing test** `sync/state.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createState, stateDir } from './state.mjs';

const fresh = () => createState(join(mkdtempSync(join(tmpdir(), 'state-')), 'agent-sync'));

test('stateDir follows XDG_STATE_HOME', () => {
  assert.equal(stateDir({ XDG_STATE_HOME: '/s' }, '/h'), '/s/agent-sync');
  assert.equal(stateDir({}, '/h'), '/h/.local/state/agent-sync');
});

test('stop, stopped, resume', () => {
  const s = fresh();
  assert.equal(s.stopped('a'), null);
  s.stop('a', 'conflict in x.md');
  assert.equal(s.stopped('a'), 'conflict in x.md');
  assert.equal(s.stopped('b'), null);
  assert.equal(s.resume('a'), true);
  assert.equal(s.stopped('a'), null);
  assert.equal(s.resume('a'), false);
});

test('store state and status round-trip, with empty defaults', () => {
  const s = fresh();
  assert.deepEqual(s.store('a'), {});
  s.saveStore('a', { offset: 12, writes: [] });
  assert.deepEqual(s.store('a'), { offset: 12, writes: [] });
  assert.deepEqual(s.status(), { stores: {} });
  s.saveStatus({ stores: { a: { result: 'ok' } } });
  assert.equal(s.status().stores.a.result, 'ok');
  assert.ok(!existsSync(join(s.dir, 'status.json.tmp')));
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test sync/state.test.mjs`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement** `sync/state.mjs`

```js
/** Everything the sync remembers between passes, under one folder per machine. */
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const stateDir = (env = process.env, home = homedir()) =>
  join(env.XDG_STATE_HOME || join(home, '.local', 'state'), 'agent-sync');

const readJson = (path, fallback) => {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
};

const writeJson = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
};

export function createState(dir) {
  const at = (...parts) => join(dir, ...parts);
  return {
    dir,
    lockPath: at('sync.lock'),
    stopped(name) {
      try { return readFileSync(at('stopped', name), 'utf8'); } catch { return null; }
    },
    stop(name, reason) {
      mkdirSync(at('stopped'), { recursive: true });
      writeFileSync(at('stopped', name), reason);
    },
    resume(name) {
      const had = existsSync(at('stopped', name));
      rmSync(at('stopped', name), { force: true });
      return had;
    },
    store: (name) => readJson(at('stores', `${name}.json`), {}),
    saveStore: (name, value) => writeJson(at('stores', `${name}.json`), value),
    status: () => readJson(at('status.json'), { stores: {} }),
    saveStatus: (value) => writeJson(at('status.json'), value),
  };
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `node --test sync/state.test.mjs`
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add sync/state.mjs sync/state.test.mjs
git commit -m "Memory sync: per-machine state"
```

---

### Task 4: Aside lost-update guard

**Files:**
- Create: `sync/aside-guard.mjs`, `sync/aside-guard.test.mjs`

**Interfaces:**
- Consumes: `git(args, opts)` from Task 1.
- Produces:
  - `sha256(textOrBuffer) -> hex`
  - `WRITE_TTL_MS = 86_400_000`
  - `readNewRuns(logPath, offset?: number) -> { runs: object[], offset: number }`. With `offset` undefined it returns no runs and the current size, so a 590 MB log is never read whole on first sight.
  - `findLostUpdates(runs, writes) -> { path, base, postBlob }[]`, `writes: { path, preSha, postBlob, writtenAt }[]`.
  - `mergeLostUpdate({ workTree, path, base, theirs }) -> { clean: boolean }`
  - `writesFromMerge(g, from, to, now) -> writes[]`, `g` a store runner from `storeGit`.
  - `pruneWrites(writes, now) -> writes[]`.

- [ ] **Step 1: Write the failing test** `sync/aside-guard.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync, readFileSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readNewRuns, findLostUpdates, mergeLostUpdate, pruneWrites, sha256, WRITE_TTL_MS } from './aside-guard.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'guard-'));
const run = (o) => `${JSON.stringify(o)}\n`;

test('first sight starts from the end of the log', () => {
  const log = join(tmp(), '.history.jsonl');
  writeFileSync(log, run({ id: 'old' }));
  const r = readNewRuns(log, undefined);
  assert.deepEqual(r.runs, []);
  assert.equal(r.offset, readFileSync(log).length);
});

test('reads only complete new lines, and resets when the log shrinks', () => {
  const log = join(tmp(), '.history.jsonl');
  writeFileSync(log, run({ id: 'a' }));
  let r = readNewRuns(log, 0);
  assert.deepEqual(r.runs.map((x) => x.id), ['a']);
  appendFileSync(log, `${run({ id: 'b' })}{"id":"half`);
  r = readNewRuns(log, r.offset);
  assert.deepEqual(r.runs.map((x) => x.id), ['b']);
  appendFileSync(log, '"}\n');
  r = readNewRuns(log, r.offset);
  assert.deepEqual(r.runs.map((x) => x.id), ['half']);
  truncateSync(log, 0);
  writeFileSync(log, run({ id: 'c' }));
  r = readNewRuns(log, 10_000);
  assert.deepEqual(r.runs.map((x) => x.id), ['c']);
});

test('a missing log is no runs', () => {
  assert.deepEqual(readNewRuns(join(tmp(), 'none.jsonl'), 5), { runs: [], offset: 0 });
});

const T = Date.parse('2026-10-07T10:00:00Z');
const write = { path: 'n.md', preSha: sha256('old\n'), postBlob: 'abc', writtenAt: T };
const aRun = (change, start = T - 1000, end = T + 1000) => ({
  startedAt: new Date(start).toISOString(), finishedAt: new Date(end).toISOString(), changes: [change],
});

test('a run that read before the sync wrote and saved after is a lost update', () => {
  const lost = findLostUpdates([aRun({ path: 'n.md', beforeSha256: sha256('old\n'), beforeContent: 'old\n' })], [write]);
  assert.deepEqual(lost, [{ path: 'n.md', base: 'old\n', postBlob: 'abc' }]);
});

test('runs based on the synced version, outside the window, or creating a note are not', () => {
  const based = aRun({ path: 'n.md', beforeSha256: sha256('new\n'), beforeContent: 'new\n' });
  const before = aRun({ path: 'n.md', beforeSha256: sha256('old\n'), beforeContent: 'old\n' }, T - 5000, T - 2000);
  const created = aRun({ path: 'n.md', beforeSha256: null, beforeContent: null });
  const other = aRun({ path: 'm.md', beforeSha256: sha256('old\n'), beforeContent: 'old\n' });
  assert.deepEqual(findLostUpdates([based, before, created, other], [write]), []);
});

test('three-way merge keeps both sides, or reports a conflict', () => {
  const dir = tmp();
  const base = 'a\nb\nc\nd\ne\n';
  writeFileSync(join(dir, 'n.md'), 'a\nb\nc\nd\nE\n'); // Aside's write
  assert.deepEqual(mergeLostUpdate({ workTree: dir, path: 'n.md', base, theirs: 'A\nb\nc\nd\ne\n' }), { clean: true });
  assert.equal(readFileSync(join(dir, 'n.md'), 'utf8'), 'A\nb\nc\nd\nE\n');

  writeFileSync(join(dir, 'n.md'), 'a\nb\nX\nd\ne\n');
  assert.deepEqual(mergeLostUpdate({ workTree: dir, path: 'n.md', base, theirs: 'a\nb\nY\nd\ne\n' }), { clean: false });
  assert.equal(readFileSync(join(dir, 'n.md'), 'utf8'), 'a\nb\nX\nd\ne\n', 'Aside file untouched on conflict');
});

test('old writes are pruned', () => {
  const now = T + WRITE_TTL_MS + 1;
  assert.deepEqual(pruneWrites([write, { ...write, writtenAt: now - 10 }], now).length, 1);
  assert.deepEqual(pruneWrites(undefined, now), []);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test sync/aside-guard.test.mjs`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement** `sync/aside-guard.mjs`

```js
/**
 * Aside rewrites a note after each of its sessions, with no lock on the
 * markdown: it reads the note, works for up to a few minutes, then writes it.
 * If a sync merge changed the note in between, Aside's write is based on the
 * older version and silently undoes the merge.
 *
 * Aside's run log (.history.jsonl) records, per change, the SHA-256 of the note
 * it started from. The sync records every note it writes. A run that started
 * from the version the sync replaced, and finished after the sync wrote, lost
 * the sync's change; a three-way merge puts it back.
 */
import { createHash } from 'node:crypto';
import {
  openSync, readSync, fstatSync, closeSync, readFileSync, writeFileSync, renameSync, mkdtempSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { git } from './git.mjs';

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');
export const WRITE_TTL_MS = 24 * 60 * 60 * 1000;

export function readNewRuns(logPath, offset) {
  let fd;
  try { fd = openSync(logPath, 'r'); } catch { return { runs: [], offset: 0 }; }
  try {
    const size = fstatSync(fd).size;
    if (offset === undefined || offset === null) return { runs: [], offset: size };
    let from = offset > size ? 0 : offset;
    if (from === size) return { runs: [], offset: size };
    const buf = Buffer.alloc(size - from);
    readSync(fd, buf, 0, buf.length, from);
    const end = buf.lastIndexOf(0x0a);
    if (end < 0) return { runs: [], offset: from };
    const runs = [];
    for (const line of buf.subarray(0, end).toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      try { runs.push(JSON.parse(line)); } catch { /* a line Aside never finished; skip it */ }
    }
    return { runs, offset: from + end + 1 };
  } finally {
    closeSync(fd);
  }
}

export function findLostUpdates(runs, writes) {
  const lost = [];
  for (const run of runs) {
    const start = Date.parse(run.startedAt);
    const end = Date.parse(run.finishedAt);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    for (const c of run.changes ?? []) {
      if (!c.beforeSha256) continue;
      const w = writes.find((x) => x.path === c.path && x.preSha === c.beforeSha256
        && x.writtenAt >= start && x.writtenAt <= end);
      if (w) lost.push({ path: c.path, base: c.beforeContent ?? '', postBlob: w.postBlob });
    }
  }
  return lost;
}

export function mergeLostUpdate({ workTree, path, base, theirs }) {
  const file = join(workTree, path);
  const tmp = mkdtempSync(join(tmpdir(), 'agent-sync-'));
  try {
    const ours = join(tmp, 'aside');
    const before = join(tmp, 'before');
    const sync = join(tmp, 'sync');
    writeFileSync(ours, readFileSync(file));
    writeFileSync(before, base);
    writeFileSync(sync, theirs);
    const r = git(['merge-file', '-p', ours, before, sync], { cwd: tmp });
    if (r.code !== 0) return { clean: false };
    const out = join(dirname(file), `.${basename(file)}.agent-sync.tmp`);
    writeFileSync(out, r.stdout);
    renameSync(out, file);
    return { clean: true };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Notes a merge from `from` to `to` changed, with their content before and the blob after. */
export function writesFromMerge(g, from, to, now) {
  const names = g(['diff', '--name-only', '--no-renames', '-z', from, to]).stdout.split('\0').filter(Boolean);
  const writes = [];
  for (const path of names) {
    const pre = g(['cat-file', 'blob', `${from}:${path}`], { encoding: 'buffer' });
    const post = g(['rev-parse', '--verify', '-q', `${to}:${path}`]);
    if (pre.code !== 0 || post.code !== 0) continue; // added or deleted: Aside cannot have started from it
    writes.push({ path, preSha: sha256(pre.stdout), postBlob: post.stdout.trim(), writtenAt: now });
  }
  return writes;
}

export const pruneWrites = (writes, now) => (writes ?? []).filter((w) => now - w.writtenAt < WRITE_TTL_MS);
```

- [ ] **Step 4: Run tests, verify pass**

Run: `node --test sync/aside-guard.test.mjs`
Expected: 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add sync/aside-guard.mjs sync/aside-guard.test.mjs
git commit -m "Memory sync: repair notes Aside overwrote mid-sync"
```

---

### Task 5: one pass for one store

**Files:**
- Create: `sync/store.mjs`, `sync/test-helpers.mjs`, `sync/store.test.mjs`

**Interfaces:**
- Consumes: `storeGit`, `GitError` (Task 1); `findSecrets` (Task 2); `createState` (Task 3); `readNewRuns`, `findLostUpdates`, `mergeLostUpdate`, `writesFromMerge`, `pruneWrites` (Task 4).
- Produces: `syncStore(store, ctx) -> { status: 'ok'|'stopped'|'offline'|'retry', detail?: string, newlyStopped?: true }`, `ctx = { state, machine, now?: () => number, notify?: (title, body) => void, beforePush?: () => void }`. Test helpers: `rig() -> { root, remote, clone(name) -> dir, store(dir, extra?) -> Store, state(name) -> State, write(dir, rel, text), read(dir, rel), sh(dir, ...args) -> stdout }`.

- [ ] **Step 1: Write** `sync/test-helpers.mjs`

```js
/** Temporary remotes and clones standing in for machines. */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { git } from './git.mjs';
import { createState } from './state.mjs';

const ID = ['-c', 'user.name=test', '-c', 'user.email=test@test'];

export function rig({ seed = { 'notes/a.md': 'one\ntwo\nthree\n', 'episodic/2026-10-07.md': '# 2026-10-07\n' } } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sync-rig-')));
  const remote = join(root, 'remote.git');
  const sh = (dir, ...args) => {
    const r = git([...ID, ...args], { cwd: dir });
    if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout;
  };
  const write = (dir, rel, text) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text); };
  const read = (dir, rel) => readFileSync(join(dir, rel), 'utf8');
  sh(root, 'init', '-q', '--bare', '-b', 'main', remote);
  const seedDir = join(root, 'seed');
  sh(root, 'clone', '-q', remote, seedDir);
  for (const [rel, text] of Object.entries(seed)) write(seedDir, rel, text);
  sh(seedDir, 'add', '-A');
  sh(seedDir, 'commit', '-q', '-m', 'seed');
  sh(seedDir, 'push', '-q', 'origin', 'HEAD:main');
  const clone = (name) => {
    const dir = join(root, name);
    sh(root, 'clone', '-q', remote, dir);
    writeFileSync(join(dir, '.git', 'info', 'attributes'), '**/episodic/*.md merge=union\n');
    return dir;
  };
  const store = (dir, extra = {}) => ({
    name: 'mem', workTree: dir, gitDir: null, remote, branch: 'main',
    mode: 'readwrite', aside: false, relativeLinks: false, ...extra,
  });
  const state = (name) => createState(join(root, `state-${name}`));
  return { root, remote, clone, store, state, write, read, sh };
}
```

- [ ] **Step 2: Write the failing test** `sync/store.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { rig } from './test-helpers.mjs';
import { syncStore } from './store.mjs';
import { sha256 } from './aside-guard.mjs';

const ctx = (state, extra = {}) => ({ state, machine: 'test', ...extra });

test('a change on one machine reaches the other', () => {
  const r = rig();
  const a = r.clone('a'); const b = r.clone('b');
  r.write(a, 'notes/new note é.md', 'hello\n');
  assert.equal(syncStore(r.store(a), ctx(r.state('a'))).status, 'ok');
  assert.equal(syncStore(r.store(b), ctx(r.state('b'))).status, 'ok');
  assert.equal(r.read(b, 'notes/new note é.md'), 'hello\n');
  assert.match(r.sh(a, 'log', '-1', '--format=%an <%ae> %s'), /^agent-sync <agent-sync@test> sync from test/);
});

test('episodic lines added on both machines are both kept', () => {
  const r = rig();
  const a = r.clone('a'); const b = r.clone('b');
  appendFileSync(join(a, 'episodic/2026-10-07.md'), 'from a\n');
  appendFileSync(join(b, 'episodic/2026-10-07.md'), 'from b\n');
  syncStore(r.store(a), ctx(r.state('a')));
  assert.equal(syncStore(r.store(b), ctx(r.state('b'))).status, 'ok');
  syncStore(r.store(a), ctx(r.state('a')));
  for (const dir of [a, b]) {
    const text = r.read(dir, 'episodic/2026-10-07.md');
    assert.ok(text.includes('from a') && text.includes('from b'), dir);
  }
});

test('the same line edited on both machines stops only that store, work tree intact', () => {
  const r = rig();
  const a = r.clone('a'); const b = r.clone('b');
  r.write(a, 'notes/a.md', 'one\nTWO-A\nthree\n');
  r.write(b, 'notes/a.md', 'one\nTWO-B\nthree\n');
  syncStore(r.store(a), ctx(r.state('a')));
  const notes = [];
  const sb = r.state('b');
  const res = syncStore(r.store(b), ctx(sb, { notify: (t, m) => notes.push(m) }));
  assert.equal(res.status, 'stopped');
  assert.match(res.detail, /notes\/a\.md/);
  assert.equal(r.read(b, 'notes/a.md'), 'one\nTWO-B\nthree\n');
  assert.ok(!existsSync(join(b, '.git', 'MERGE_HEAD')));
  assert.equal(notes.length, 1);
  assert.equal(syncStore(r.store(b), ctx(sb, { notify: (t, m) => notes.push(m) })).status, 'stopped');
  assert.equal(notes.length, 1, 'notified once, not every pass');
});

test('a token stops the store before anything is committed', () => {
  const r = rig();
  const a = r.clone('a');
  const token = `xoxb-${'1'.repeat(30)}`;
  r.write(a, 'notes/slack.md', `bot: ${token}\n`);
  const before = r.sh(a, 'rev-parse', 'HEAD');
  const res = syncStore(r.store(a), ctx(r.state('a')));
  assert.equal(res.status, 'stopped');
  assert.match(res.detail, /notes\/slack\.md \(slack-token\)/);
  assert.ok(!res.detail.includes(token));
  assert.equal(r.sh(a, 'rev-parse', 'HEAD'), before);
  assert.equal(r.sh(a, 'diff', '--cached', '--name-only'), '');
});

test('a rejected push merges and retries once in the same pass', () => {
  const r = rig();
  const a = r.clone('a'); const b = r.clone('b');
  r.write(a, 'notes/from-a.md', 'a\n');
  r.write(b, 'notes/from-b.md', 'b\n');
  let raced = false;
  const res = syncStore(r.store(a), ctx(r.state('a'), {
    beforePush: () => { if (!raced) { raced = true; syncStore(r.store(b), ctx(r.state('b'))); } },
  }));
  assert.equal(res.status, 'ok');
  const c = r.clone('c');
  assert.ok(existsSync(join(c, 'notes/from-a.md')) && existsSync(join(c, 'notes/from-b.md')));
});

test('offline keeps local commits and pushes them on the next good pass', () => {
  const r = rig();
  const a = r.clone('a');
  r.write(a, 'notes/x.md', 'x\n');
  r.sh(a, 'remote', 'set-url', 'origin', join(r.root, 'missing.git'));
  const res = syncStore(r.store(a), ctx(r.state('a')));
  assert.equal(res.status, 'offline');
  assert.equal(r.state('a').stopped('mem'), null);
  r.sh(a, 'remote', 'set-url', 'origin', r.remote);
  assert.equal(syncStore(r.store(a), ctx(r.state('a'))).status, 'ok');
  assert.ok(existsSync(join(r.clone('c'), 'notes/x.md')));
});

test('pull mode never commits or pushes', () => {
  const r = rig();
  const a = r.clone('a'); const p = r.clone('p');
  r.write(p, 'notes/local-only.md', 'mine\n');
  r.write(a, 'notes/remote.md', 'theirs\n');
  syncStore(r.store(a), ctx(r.state('a')));
  assert.equal(syncStore(r.store(p, { mode: 'pull' }), ctx(r.state('p'))).status, 'ok');
  assert.equal(r.read(p, 'notes/remote.md'), 'theirs\n');
  assert.ok(!existsSync(join(r.clone('c'), 'notes/local-only.md')));
});

test('a stopped store is skipped until resumed', () => {
  const r = rig();
  const a = r.clone('a');
  const s = r.state('a');
  s.stop('mem', 'by hand');
  r.write(a, 'notes/y.md', 'y\n');
  assert.equal(syncStore(r.store(a), ctx(s)).status, 'stopped');
  assert.equal(r.sh(a, 'status', '--porcelain').trim(), '?? notes/y.md');
  s.resume('mem');
  assert.equal(syncStore(r.store(a), ctx(s)).status, 'ok');
});

test('Aside overwriting a note mid-sync is repaired, keeping both changes', () => {
  const base = 'a\nb\nc\nd\ne\n';
  const r = rig({ seed: { 'n.md': base } });
  const a = r.clone('a'); const b = r.clone('b');
  writeFileSync(join(a, '.git', 'info', 'exclude'), '.history.jsonl\n');
  const log = join(a, '.history.jsonl');
  writeFileSync(log, '');
  const sa = r.state('a');
  let t = Date.parse('2026-10-07T10:00:00Z');
  const now = () => t;
  const asideStore = r.store(a, { aside: true });

  syncStore(asideStore, ctx(sa, { now })); // first sight: offset at end of log
  r.write(b, 'n.md', 'A\nb\nc\nd\ne\n');
  syncStore(r.store(b), ctx(r.state('b')));

  t += 60_000;
  const writtenAt = t;
  syncStore(asideStore, ctx(sa, { now })); // merge writes b's change into Aside's folder
  assert.equal(r.read(a, 'n.md'), 'A\nb\nc\nd\ne\n');

  // Aside read the note before that write and saves after it.
  r.write(a, 'n.md', 'a\nb\nc\nd\nE\n');
  appendFileSync(log, `${JSON.stringify({
    startedAt: new Date(writtenAt - 30_000).toISOString(),
    finishedAt: new Date(writtenAt + 30_000).toISOString(),
    changes: [{ path: 'n.md', beforeSha256: sha256(base), beforeContent: base }],
  })}\n`);

  t += 120_000;
  assert.equal(syncStore(asideStore, ctx(sa, { now })).status, 'ok');
  assert.equal(r.read(a, 'n.md'), 'A\nb\nc\nd\nE\n');
  assert.equal(r.read(r.clone('c'), 'n.md'), 'A\nb\nc\nd\nE\n');
});

test('an Aside run based on the synced version changes nothing', () => {
  const r = rig({ seed: { 'n.md': 'a\n' } });
  const a = r.clone('a');
  writeFileSync(join(a, '.git', 'info', 'exclude'), '.history.jsonl\n');
  const log = join(a, '.history.jsonl');
  writeFileSync(log, '');
  const sa = r.state('a');
  const asideStore = r.store(a, { aside: true });
  syncStore(asideStore, ctx(sa));
  r.write(a, 'n.md', 'a\nb\n');
  appendFileSync(log, `${JSON.stringify({
    startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    changes: [{ path: 'n.md', beforeSha256: sha256('a\n'), beforeContent: 'a\n' }],
  })}\n`);
  assert.equal(syncStore(asideStore, ctx(sa)).status, 'ok');
  assert.equal(r.read(a, 'n.md'), 'a\nb\n');
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `node --test sync/store.test.mjs`
Expected: FAIL, `./store.mjs` not found.

- [ ] **Step 4: Implement** `sync/store.mjs`

```js
/**
 * One pass for one store: repair Aside overwrites, stage, scan, commit, fetch,
 * merge, push. A conflict, a secret or anything unexpected stops this store
 * only, with the reason on disk and one notification. A network failure does
 * not stop it: the next pass retries.
 */
import { join } from 'node:path';
import { storeGit, GitError } from './git.mjs';
import { findSecrets } from './secrets.mjs';
import {
  readNewRuns, findLostUpdates, mergeLostUpdate, writesFromMerge, pruneWrites,
} from './aside-guard.mjs';

const firstLine = (s) => String(s).trim().split('\n')[0].slice(0, 200);
const RESUME = (name) => `then run: node sync/sync.mjs --resume ${name}`;

export function syncStore(store, ctx) {
  const { state, machine } = ctx;
  const now = ctx.now ?? Date.now;
  const g = storeGit(store);
  const ok = (args, opts) => {
    const r = g(args, opts);
    if (r.code !== 0) throw new GitError(args, r);
    return r.stdout;
  };
  const as = ['-c', 'user.name=agent-sync', '-c', `user.email=agent-sync@${machine}`];

  const already = state.stopped(store.name);
  if (already) return { status: 'stopped', detail: already };
  const stop = (reason) => {
    state.stop(store.name, reason);
    ctx.notify?.(`Memory sync stopped: ${store.name}`, reason);
    return { status: 'stopped', detail: reason, newlyStopped: true };
  };

  try {
    const mem = state.store(store.name);
    mem.writes = pruneWrites(mem.writes, now());

    if (store.aside && store.mode === 'readwrite') {
      const { runs, offset } = readNewRuns(join(store.workTree, '.history.jsonl'), mem.offset);
      mem.offset = offset;
      for (const lost of findLostUpdates(runs, mem.writes)) {
        const theirs = ok(['cat-file', 'blob', lost.postBlob]);
        const merged = mergeLostUpdate({ workTree: store.workTree, path: lost.path, base: lost.base, theirs });
        if (!merged.clean) {
          state.saveStore(store.name, mem);
          return stop(`Aside and the sync both changed ${lost.path}; merge it by hand, ${RESUME(store.name)}`);
        }
      }
      state.saveStore(store.name, mem);
    }

    if (store.mode === 'readwrite') {
      ok(['add', '-A']);
      const diff = ok(['-c', 'core.quotepath=false', 'diff', '--cached', '-U0', '--no-color']);
      const hits = findSecrets(diff);
      if (hits.length) {
        g(['reset', '-q']);
        const list = hits.map((h) => `${h.file} (${h.pattern})`).join(', ');
        return stop(`possible secret in ${list}; remove it, ${RESUME(store.name)}`);
      }
      if (diff.trim()) ok([...as, 'commit', '-q', '--no-verify', '-m', `sync from ${machine}`]);
    }

    const upstream = `origin/${store.branch}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const fetched = g(['fetch', '-q', 'origin', store.branch]);
      if (fetched.code !== 0) return { status: 'offline', detail: firstLine(fetched.stderr) };

      const before = ok(['rev-parse', 'HEAD']).trim();
      const merged = store.mode === 'pull'
        ? g(['merge', '--ff-only', '-q', upstream])
        : g([...as, 'merge', '--no-edit', '-q', upstream]);
      if (merged.code !== 0) {
        const conflicted = g(['-c', 'core.quotepath=false', 'diff', '--name-only', '--diff-filter=U'])
          .stdout.split('\n').filter(Boolean);
        g(['merge', '--abort']);
        return stop(conflicted.length
          ? `merge conflict in ${conflicted.join(', ')}; resolve it in the repo, ${RESUME(store.name)}`
          : `merge failed: ${firstLine(merged.stderr)}; ${RESUME(store.name)}`);
      }
      const after = ok(['rev-parse', 'HEAD']).trim();
      if (store.aside && after !== before) {
        const mem = state.store(store.name);
        mem.writes = [...pruneWrites(mem.writes, now()), ...writesFromMerge(g, before, after, now())];
        state.saveStore(store.name, mem);
      }

      if (store.mode === 'pull') return { status: 'ok' };
      if (ok(['rev-list', '--count', `${upstream}..HEAD`]).trim() === '0') return { status: 'ok' };
      if (attempt === 0) ctx.beforePush?.();
      const pushed = g(['push', '-q', 'origin', `HEAD:${store.branch}`]);
      if (pushed.code === 0) return { status: 'ok' };
      if (!/rejected|fetch first|non-fast-forward/.test(pushed.stderr)) {
        return { status: 'offline', detail: firstLine(pushed.stderr) };
      }
    }
    return { status: 'retry', detail: 'another machine pushed again during this pass' };
  } catch (err) {
    return stop(`unexpected: ${firstLine(err.message)}; ${RESUME(store.name)}`);
  }
}
```

- [ ] **Step 5: Run tests, verify pass**

Run: `node --test sync/store.test.mjs`
Expected: 10 tests pass.

- [ ] **Step 6: Commit**

```bash
git add sync/store.mjs sync/store.test.mjs sync/test-helpers.mjs
git commit -m "Memory sync: one pass for one store"
```

---

### Task 6: CLI, notification and status

**Files:**
- Create: `sync/notify.mjs`, `sync/sync.mjs`, `sync/sync.test.mjs`

**Interfaces:**
- Consumes: `loadConfig` (Task 1), `createState`, `stateDir` (Task 3), `syncStore` (Task 5), `acquire`, `release` from `../bridge/lock.mjs` (`acquire({ path }) -> { ok, holder? }`, `release({ path })`).
- Produces: `notifyCommand(title, body, platform) -> [cmd, args] | null`; `notify(title, body)`; `runPass({ config, state, notify, now? }) -> status`; `main(argv, { configPath?, state?, notify? }) -> exitCode`.

- [ ] **Step 1: Write the failing test** `sync/sync.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { rig } from './test-helpers.mjs';
import { runPass, main } from './sync.mjs';
import { notifyCommand } from './notify.mjs';

test('one stopped store does not block the others, and status keeps last success', () => {
  const r = rig();
  const a = r.clone('a'); const b = r.clone('b');
  const s = r.state('b');
  const config = { machine: 'test', stores: [r.store(b, { name: 'one' }), r.store(b, { name: 'two' })] };
  let status = runPass({ config, state: s, notify: () => {} });
  assert.equal(status.stores.one.result, 'ok');
  const firstSuccess = status.stores.one.lastSuccess;
  s.stop('one', 'by hand');
  r.write(a, 'notes/z.md', 'z\n');
  runPass({ config: { machine: 'test', stores: [r.store(a)] }, state: r.state('a'), notify: () => {} });
  status = runPass({ config, state: s, notify: () => {} });
  assert.equal(status.stores.one.result, 'stopped');
  assert.equal(status.stores.one.lastSuccess, firstSuccess);
  assert.equal(status.stores.two.result, 'ok');
  assert.equal(r.read(b, 'notes/z.md'), 'z\n');
  assert.deepEqual(s.status(), status);
});

test('a second pass exits quietly while one is running', async () => {
  const r = rig();
  const a = r.clone('a');
  const s = r.state('a');
  const cfg = join(r.root, 'cfg.json');
  writeFileSync(cfg, JSON.stringify({ machine: 'test', stores: [r.store(a)] }));
  mkdirSync(s.dir, { recursive: true });
  // Held by a live process on this machine: the test runner's parent.
  writeFileSync(s.lockPath, JSON.stringify({ pid: process.ppid, host: hostname(), since: new Date().toISOString() }));
  assert.equal(await main([], { configPath: cfg, state: s, notify: () => {} }), 0);
  assert.deepEqual(s.status(), { stores: {} }, 'no pass ran');
});

test('--resume clears a stop and rejects unknown names', async () => {
  const r = rig();
  const a = r.clone('a');
  const s = r.state('a');
  const cfg = join(r.root, 'cfg.json');
  writeFileSync(cfg, JSON.stringify({ machine: 'test', stores: [r.store(a)] }));
  s.stop('mem', 'x');
  assert.equal(await main(['--resume', 'mem'], { configPath: cfg, state: s }), 0);
  assert.equal(s.stopped('mem'), null);
  assert.equal(await main(['--resume', 'nope'], { configPath: cfg, state: s }), 2);
});

test('notification command per platform', () => {
  assert.equal(notifyCommand('t', 'b', 'darwin')[0], 'osascript');
  assert.match(notifyCommand('t', 'say "hi"', 'darwin')[1][1], /display notification "say \\"hi\\"" with title "t"/);
  assert.deepEqual(notifyCommand('t', 'b', 'linux'), ['notify-send', ['t', 'b']]);
  assert.equal(notifyCommand('t', 'b', 'win32'), null);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test sync/sync.test.mjs`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement** `sync/notify.mjs`

```js
/** One desktop notification, best effort. */
import { spawnSync } from 'node:child_process';

export function notifyCommand(title, body, platform = process.platform) {
  if (platform === 'darwin') {
    return ['osascript', ['-e', `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`]];
  }
  if (platform === 'linux') return ['notify-send', [title, body]];
  return null;
}

export function notify(title, body) {
  const c = notifyCommand(title, body);
  if (c) spawnSync(c[0], c[1], { stdio: 'ignore', timeout: 5000 });
}
```

- [ ] **Step 4: Implement** `sync/sync.mjs`

```js
#!/usr/bin/env node
/**
 * One sync pass over every store in sync.config.json, then exit. A launchd or
 * systemd timer runs it every few minutes; run it by hand to sync now.
 *
 *   node sync/sync.mjs                  one pass
 *   node sync/sync.mjs --resume <store> clear a stop after fixing its cause
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { acquire, release } from '../bridge/lock.mjs';
import { loadConfig } from './config.mjs';
import { createState, stateDir } from './state.mjs';
import { syncStore } from './store.mjs';
import { notify as desktopNotify } from './notify.mjs';

export function runPass({ config, state, notify, now = Date.now }) {
  const at = new Date(now()).toISOString();
  const previous = state.status().stores ?? {};
  const status = { machine: config.machine, at, stores: {} };
  for (const store of config.stores) {
    const r = syncStore(store, { state, machine: config.machine, notify, now });
    status.stores[store.name] = {
      result: r.status,
      detail: r.detail ?? null,
      lastSuccess: r.status === 'ok' ? at : (previous[store.name]?.lastSuccess ?? null),
    };
  }
  state.saveStatus(status);
  return status;
}

export async function main(argv, {
  configPath = process.env.AGENT_SYNC_CONFIG || fileURLToPath(new URL('./sync.config.json', import.meta.url)),
  state = createState(stateDir()),
  notify = desktopNotify,
} = {}) {
  const config = loadConfig(readFileSync(configPath, 'utf8'));
  const i = argv.indexOf('--resume');
  if (i >= 0) {
    const name = argv[i + 1];
    if (!config.stores.some((s) => s.name === name)) {
      console.error(`no store named ${name ?? '(none)'}`);
      return 2;
    }
    console.log(state.resume(name) ? `resumed ${name}` : `${name} was not stopped`);
    return 0;
  }
  const lock = await acquire({ path: state.lockPath });
  if (!lock.ok) {
    console.log(`a pass is already running (pid ${lock.holder.pid}); skipping`);
    return 0;
  }
  try {
    const status = runPass({ config, state, notify });
    for (const [name, s] of Object.entries(status.stores)) {
      console.log(`${status.at} ${name}: ${s.result}${s.detail ? ` (${s.detail})` : ''}`);
    }
    return 0;
  } finally {
    await release({ path: state.lockPath });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = await main(process.argv.slice(2));
```

- [ ] **Step 5: Run tests, verify pass**

Run: `node --test sync/sync.test.mjs`
Expected: 4 tests pass.

- [ ] **Step 6: Commit**

```bash
git add sync/notify.mjs sync/sync.mjs sync/sync.test.mjs
git commit -m "Memory sync: CLI, status and notifications"
```

---

### Task 7: setup per machine

**Files:**
- Create: `sync/setup.mjs`, `sync/setup.test.mjs`

**Interfaces:**
- Consumes: `git`, `storeGit` (Task 1), `loadConfig` (Task 1), `findSecrets` (Task 2), `createState`, `stateDir` (Task 3).
- Produces: `ATTRIBUTES`, `ASIDE_EXCLUDE`, `TARA_GITIGNORE` (strings); `launchdPlist({ node, script, intervalMinutes, logPath, path }) -> string`; `systemdUnits({ node, script, intervalMinutes }) -> { service, timer }`; `relinkRelative(root, sharedParent) -> { changed: string[], outside: string[] }`; `prepareStore(store, { machine, state, log }) -> 'cloned'|'initialised'|'merged'|'ready'|'stopped'`.

- [ ] **Step 1: Write the failing test** `sync/setup.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readlinkSync, realpathSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { git } from './git.mjs';
import { rig } from './test-helpers.mjs';
import { createState } from './state.mjs';
import {
  launchdPlist, systemdUnits, relinkRelative, prepareStore, TARA_GITIGNORE, ASIDE_EXCLUDE,
} from './setup.mjs';

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'setup-')));

test('launchd plist runs node on the script at the interval', () => {
  const p = launchdPlist({ node: '/opt/homebrew/bin/node', script: '/x/sync.mjs', intervalMinutes: 5, logPath: '/l/agent-sync.log', path: '/opt/homebrew/bin:/usr/bin:/bin' });
  assert.match(p, /<string>com\.agent-sync<\/string>/);
  assert.match(p, /<string>\/opt\/homebrew\/bin\/node<\/string>\s*<string>\/x\/sync\.mjs<\/string>/);
  assert.match(p, /<key>StartInterval<\/key>\s*<integer>300<\/integer>/);
  assert.match(p, /<key>RunAtLoad<\/key>\s*<true\/>/);
});

test('systemd timer fires every interval', () => {
  const { service, timer } = systemdUnits({ node: '/usr/bin/node', script: '/x/sync.mjs', intervalMinutes: 5 });
  assert.match(service, /Type=oneshot/);
  assert.match(service, /ExecStart=\/usr\/bin\/node \/x\/sync\.mjs/);
  assert.match(timer, /OnUnitActiveSec=5min/);
  assert.match(timer, /OnBootSec=2min/);
});

test('absolute links into the shared parent become relative; others are listed', () => {
  const parent = tmp();
  const hm = join(parent, 'hammock-memory', 'skills', 'channel');
  mkdirSync(hm, { recursive: true });
  const tara = join(parent, 'tara-workspace');
  mkdirSync(join(tara, 'skills'), { recursive: true });
  symlinkSync(hm, join(tara, 'skills', 'channel'));
  symlinkSync('/etc/hosts', join(tara, 'skills', 'outside'));
  symlinkSync('../skills', join(tara, 'already'));
  const r = relinkRelative(tara, parent);
  assert.equal(readlinkSync(join(tara, 'skills', 'channel')), '../../hammock-memory/skills/channel');
  assert.deepEqual(r.changed, ['skills/channel']);
  assert.deepEqual(r.outside, ['skills/outside']);
  assert.equal(readlinkSync(join(tara, 'already')), '../skills');
});

const ignored = (dir, path) => git(['check-ignore', '-q', path], { cwd: dir }).code === 0;

test("Tara's allowlist tracks her notes and links, nothing else", () => {
  const dir = tmp();
  git(['init', '-q'], { cwd: dir });
  writeFileSync(join(dir, '.gitignore'), TARA_GITIGNORE);
  const files = ['CLAUDE.md', 'memory/tara/x.md', 'memory/shared/INDEX.md', 'memory/routines/README.md',
    'skills/skill-creator/SKILL.md', 'transcripts/a.jsonl', 'memory/repo-sync.md', '.claude/settings.json', 'notes.txt'];
  for (const p of files) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), 'x\n'); }
  for (const p of ['CLAUDE.md', 'memory/tara/x.md', 'memory/shared/INDEX.md', 'memory/routines/README.md', 'skills/skill-creator/SKILL.md', '.gitignore']) {
    assert.equal(ignored(dir, p), false, p);
  }
  for (const p of ['transcripts/a.jsonl', 'memory/repo-sync.md', '.claude/settings.json', 'notes.txt']) {
    assert.equal(ignored(dir, p), true, p);
  }
  symlinkSync('../skills', join(dir, '.claude', 'skills'));
  assert.equal(ignored(dir, '.claude/skills'), false);
});

test("Aside's exclude tracks markdown only", () => {
  const dir = tmp();
  git(['init', '-q'], { cwd: dir });
  writeFileSync(join(dir, '.git', 'info', 'exclude'), ASIDE_EXCLUDE);
  for (const p of ['MEMORY.md', 'episodic/2026-10-07.md', 'people/jane doe.md']) assert.equal(ignored(dir, p), false, p);
  for (const p of ['.history.jsonl', 'memory-index-local.json', '.local-memory/memory/x.md', 'x.json']) assert.equal(ignored(dir, p), true, p);
});

test('first machine pushes its notes; second machine merges its own in', () => {
  const r = rig();
  const remote = join(r.root, 'aside.git');
  git(['init', '-q', '--bare', '-b', 'main', remote], { cwd: r.root });
  const mk = (name, files) => {
    const work = join(r.root, name, 'memory');
    for (const [p, t] of Object.entries(files)) { mkdirSync(join(work, p, '..'), { recursive: true }); writeFileSync(join(work, p), t); }
    return { name: 'aside-u0', workTree: work, gitDir: join(r.root, name, 'aside-u0.git'), remote, branch: 'main', mode: 'readwrite', aside: true, relativeLinks: false };
  };
  const one = mk('m1', { 'MEMORY.md': 'one\n', '.history.jsonl': '{}\n' });
  const two = mk('m2', { 'people/jane.md': 'jane\n', '.history.jsonl': '{}\n' });
  const log = () => {};
  assert.equal(prepareStore(one, { machine: 'm1', state: r.state('m1'), log }), 'initialised');
  assert.equal(prepareStore(two, { machine: 'm2', state: r.state('m2'), log }), 'merged');
  assert.ok(existsSync(join(two.workTree, 'MEMORY.md')));
  assert.ok(!existsSync(join(two.workTree, '.git')), 'nothing new inside the Aside folder');
  const files = git(['ls-tree', '-r', '--name-only', 'origin/main'], { gitDir: two.gitDir, workTree: two.workTree }).stdout;
  assert.ok(!files.includes('.history.jsonl'));
  assert.equal(prepareStore(two, { machine: 'm2', state: r.state('m2'), log }), 'ready', 'idempotent');
  assert.equal(r.state('m2').store('aside-u0').offset, 3, 'run log starts from its end');
});

test('a token in existing notes stops setup before the first commit', () => {
  const root = tmp();
  const remote = join(root, 'r.git');
  git(['init', '-q', '--bare', '-b', 'main', remote], { cwd: root });
  const work = join(root, 'w');
  mkdirSync(work);
  writeFileSync(join(work, 'CLAUDE.md'), `token xoxb-${'1'.repeat(30)}\n`);
  const store = { name: 'tara', workTree: work, gitDir: null, remote, branch: 'main', mode: 'readwrite', aside: false, relativeLinks: false };
  const state = createState(join(root, 'state'));
  assert.equal(prepareStore(store, { machine: 't', state, log: () => {} }), 'stopped');
  assert.match(state.stopped('tara'), /CLAUDE\.md \(slack-token\)/);
  assert.equal(git(['rev-parse', '-q', '--verify', 'HEAD'], { cwd: work }).code, 1, 'no commit made');
});

test('a missing work tree is cloned', () => {
  const r = rig();
  const target = join(r.root, 'fresh');
  const store = r.store(target);
  assert.equal(prepareStore(store, { machine: 'x', state: r.state('x'), log: () => {} }), 'cloned');
  assert.ok(existsSync(join(target, 'notes/a.md')));
  assert.match(readFileSync(join(target, '.git', 'info', 'attributes'), 'utf8'), /merge=union/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test sync/setup.test.mjs`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement** `sync/setup.mjs`

```js
#!/usr/bin/env node
/**
 * Prepare this machine: each store's repo, Tara's links, and the timer.
 * Safe to run again. Creating the private GitHub repos is a manual step.
 *
 *   node sync/setup.mjs             prepare stores and install the timer
 *   node sync/setup.mjs --no-timer  prepare stores only
 */
import {
  existsSync, mkdirSync, readdirSync, lstatSync, readlinkSync, unlinkSync, symlinkSync, writeFileSync, readFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir, platform } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, storeGit } from './git.mjs';
import { loadConfig } from './config.mjs';
import { findSecrets } from './secrets.mjs';
import { createState, stateDir } from './state.mjs';

export const ATTRIBUTES = '**/episodic/*.md merge=union\n';

// Only notes. The run log, search index and model files stay on each machine.
export const ASIDE_EXCLUDE = '*\n!*/\n!*.md\n.local-memory/\n';

// Everything private unless listed: a new file in her workspace stays local
// until someone decides otherwise.
export const TARA_GITIGNORE = [
  '/*',
  '!/.gitignore',
  '!/CLAUDE.md',
  '!/skills/',
  '!/memory/',
  '/memory/repo-sync.md',
  '!/.claude/',
  '/.claude/*',
  '!/.claude/skills',
  '',
].join('\n');

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function launchdPlist({ node, script, intervalMinutes, logPath, path }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.agent-sync</string>
    <key>ProgramArguments</key>
    <array>
        <string>${xml(node)}</string>
        <string>${xml(script)}</string>
    </array>
    <key>StartInterval</key>
    <integer>${intervalMinutes * 60}</integer>
    <key>RunAtLoad</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${xml(path)}</string>
    </dict>
    <key>StandardOutPath</key>
    <string>${xml(logPath)}</string>
    <key>StandardErrorPath</key>
    <string>${xml(logPath)}</string>
</dict>
</plist>
`;
}

export function systemdUnits({ node, script, intervalMinutes }) {
  return {
    service: `[Unit]\nDescription=Agent memory sync, one pass\n\n[Service]\nType=oneshot\nExecStart=${node} ${script}\n`,
    timer: `[Unit]\nDescription=Agent memory sync every ${intervalMinutes} minutes\n\n[Timer]\nOnBootSec=2min\nOnUnitActiveSec=${intervalMinutes}min\nUnit=agent-sync.service\n\n[Install]\nWantedBy=timers.target\n`,
  };
}

/** Turn absolute links that point inside `sharedParent` into relative ones. */
export function relinkRelative(root, sharedParent) {
  const changed = [];
  const outside = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const rel = relative(root, full);
      if (rel === 'transcripts' || rel === '.git') continue;
      const st = lstatSync(full);
      if (st.isSymbolicLink()) {
        const target = readlinkSync(full);
        if (!isAbsolute(target)) continue;
        if (!(target + sep).startsWith(sharedParent + sep)) { outside.push(rel); continue; }
        unlinkSync(full);
        symlinkSync(relative(dirname(full), target), full);
        changed.push(rel);
      } else if (st.isDirectory()) {
        walk(full);
      }
    }
  };
  walk(root);
  return { changed: changed.sort(), outside: outside.sort() };
}

const infoDir = (store) => join(store.gitDir ?? join(store.workTree, '.git'), 'info');

function writeInfo(store) {
  mkdirSync(infoDir(store), { recursive: true });
  writeFileSync(join(infoDir(store), 'attributes'), ATTRIBUTES);
  if (store.aside) writeFileSync(join(infoDir(store), 'exclude'), ASIDE_EXCLUDE);
}

export function prepareStore(store, { machine, state, log = console.log }) {
  const g = storeGit(store);
  const as = ['-c', 'user.name=agent-sync', '-c', `user.email=agent-sync@${machine}`];
  const gitDir = store.gitDir ?? join(store.workTree, '.git');

  if (store.aside && store.mode === 'readwrite' && state.store(store.name).offset === undefined) {
    // Start reading Aside's run log from its end: the past is already settled.
    let size = 0;
    try { size = readFileSync(join(store.workTree, '.history.jsonl')).length; } catch { /* no log yet */ }
    state.saveStore(store.name, { ...state.store(store.name), offset: size, writes: [] });
  }

  if (existsSync(gitDir)) { writeInfo(store); return 'ready'; }

  if (!existsSync(store.workTree)) {
    mkdirSync(dirname(store.workTree), { recursive: true });
    const args = ['clone', '-q', '-b', store.branch];
    if (store.gitDir) args.push('--separate-git-dir', store.gitDir);
    const r = git([...args, store.remote, store.workTree], { cwd: dirname(store.workTree) });
    if (r.code !== 0) throw new Error(`clone ${store.name}: ${r.stderr.trim()}`);
    if (store.gitDir) git(['config', 'core.worktree', store.workTree], { gitDir: store.gitDir });
    // --separate-git-dir leaves a .git file in the work tree; Aside's folder must stay clean.
    if (store.gitDir && store.aside) unlinkSync(join(store.workTree, '.git'));
    writeInfo(store);
    log(`${store.name}: cloned`);
    return 'cloned';
  }

  // The work tree exists with files (Tara's workspace, Aside's notes): make it a repo.
  mkdirSync(dirname(gitDir), { recursive: true });
  const init = git(['init', '-q', '-b', store.branch], store.gitDir
    ? { gitDir: store.gitDir, workTree: store.workTree }
    : { cwd: store.workTree });
  if (init.code !== 0) throw new Error(`init ${store.name}: ${init.stderr.trim()}`);
  if (store.gitDir) g(['config', 'core.worktree', store.workTree]);
  g(['remote', 'add', 'origin', store.remote]);
  writeInfo(store);
  if (store.relativeLinks) {
    const parent = dirname(store.workTree);
    const r = relinkRelative(store.workTree, parent);
    if (r.changed.length) log(`${store.name}: made ${r.changed.length} links relative`);
    if (r.outside.length) log(`${store.name}: links outside ${parent}, left absolute: ${r.outside.join(', ')}`);
    if (!existsSync(join(store.workTree, '.gitignore'))) writeFileSync(join(store.workTree, '.gitignore'), TARA_GITIGNORE);
  }

  g(['add', '-A']);
  const hits = findSecrets(g(['-c', 'core.quotepath=false', 'diff', '--cached', '-U0', '--no-color']).stdout);
  if (hits.length) {
    g(['reset', '-q']);
    state.stop(store.name, `possible secret in ${hits.map((h) => `${h.file} (${h.pattern})`).join(', ')}; remove it, then run setup again and: node sync/sync.mjs --resume ${store.name}`);
    log(`${store.name}: stopped, see ${join(state.dir, 'stopped', store.name)}`);
    return 'stopped';
  }
  g([...as, 'commit', '-q', '--allow-empty', '-m', `first sync from ${machine}`]);

  const fetched = g(['fetch', '-q', 'origin']);
  if (fetched.code !== 0) throw new Error(`fetch ${store.name}: ${fetched.stderr.trim()}`);
  const remoteHas = g(['rev-parse', '-q', '--verify', `origin/${store.branch}`]).code === 0;
  if (!remoteHas) {
    const p = g(['push', '-q', '-u', 'origin', `HEAD:${store.branch}`]);
    if (p.code !== 0) throw new Error(`push ${store.name}: ${p.stderr.trim()}`);
    log(`${store.name}: first copy pushed`);
    return 'initialised';
  }
  const m = g([...as, 'merge', '--no-edit', '-q', '--allow-unrelated-histories', `origin/${store.branch}`]);
  if (m.code !== 0) {
    const conflicted = g(['diff', '--name-only', '--diff-filter=U']).stdout.split('\n').filter(Boolean);
    g(['merge', '--abort']);
    state.stop(store.name, `first merge conflicts in ${conflicted.join(', ')}; resolve, then: node sync/sync.mjs --resume ${store.name}`);
    log(`${store.name}: stopped on first merge`);
    return 'stopped';
  }
  g(['branch', '-q', '--set-upstream-to', `origin/${store.branch}`]);
  const p = g(['push', '-q', 'origin', `HEAD:${store.branch}`]);
  if (p.code !== 0) throw new Error(`push ${store.name}: ${p.stderr.trim()}`);
  log(`${store.name}: merged with the copy already on the remote`);
  return 'merged';
}

function installTimer(config, script) {
  const node = spawnSync('sh', ['-c', 'command -v node'], { encoding: 'utf8' }).stdout.trim() || process.execPath;
  if (platform() === 'darwin') {
    const plist = join(homedir(), 'Library', 'LaunchAgents', 'com.agent-sync.plist');
    writeFileSync(plist, launchdPlist({
      node, script, intervalMinutes: config.intervalMinutes,
      logPath: join(homedir(), 'Library', 'Logs', 'agent-sync.log'),
      path: `${dirname(node)}:/usr/local/bin:/usr/bin:/bin`,
    }));
    const uid = process.getuid();
    spawnSync('launchctl', ['bootout', `gui/${uid}/com.agent-sync`], { stdio: 'ignore' });
    const r = spawnSync('launchctl', ['bootstrap', `gui/${uid}`, plist], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`launchctl bootstrap: ${r.stderr.trim()}`);
    return plist;
  }
  const dir = join(homedir(), '.config', 'systemd', 'user');
  mkdirSync(dir, { recursive: true });
  const { service, timer } = systemdUnits({ node, script, intervalMinutes: config.intervalMinutes });
  writeFileSync(join(dir, 'agent-sync.service'), service);
  writeFileSync(join(dir, 'agent-sync.timer'), timer);
  spawnSync('systemctl', ['--user', 'daemon-reload']);
  const r = spawnSync('systemctl', ['--user', 'enable', '--now', 'agent-sync.timer'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`systemctl enable: ${r.stderr.trim()}`);
  return join(dir, 'agent-sync.timer');
}

async function main(argv) {
  const here = dirname(fileURLToPath(import.meta.url));
  const configPath = process.env.AGENT_SYNC_CONFIG || join(here, 'sync.config.json');
  if (!existsSync(configPath)) {
    console.error(`No ${configPath}. Copy sync.config.example.json there and fill it in.`);
    return 2;
  }
  const config = loadConfig(readFileSync(configPath, 'utf8'));
  const state = createState(stateDir());
  console.log('Create these private GitHub repos first if they do not exist yet:');
  for (const s of config.stores) console.log(`  ${s.remote}`);
  for (const store of config.stores) prepareStore(store, { machine: config.machine, state });
  if (!argv.includes('--no-timer')) console.log(`timer installed: ${installTimer(config, resolve(here, 'sync.mjs'))}`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = await main(process.argv.slice(2));
```

- [ ] **Step 4: Run tests, verify pass**

Run: `node --test sync/setup.test.mjs`
Expected: 8 tests pass. If the "first machine" test fails on `nothing new inside the Aside folder`, the init path left a `.git` file: confirm `git init` with `GIT_DIR` and `GIT_WORK_TREE` set does not create one (it does not as of git 2.56).

- [ ] **Step 5: Run the whole suite**

Run: `node --test sync/*.test.mjs bridge/*.test.mjs`
Expected: all pass, bridge count unchanged.

- [ ] **Step 6: Commit**

```bash
git add sync/setup.mjs sync/setup.test.mjs
git commit -m "Memory sync: per-machine setup and timer"
```

---

### Task 8: roll out (with the operator)

Not code. Each step needs a person, or a machine the session cannot reach.

- [ ] **Step 1:** The operator creates private GitHub repos `tara-memory`, `aside-memory-u0`, `aside-memory-u3`, empty (no README).
- [ ] **Step 2 (Mac A):** `cp sync/sync.config.example.json sync/sync.config.json`; set `machine` to `mac-a` and the three new remotes. Run `node sync/setup.mjs --no-timer`. Expected: hammock `ready`, tara `initialised`, aside-u0 `initialised`, aside-u3 `initialised`. Check that `~/.aside/u/0/memory` has no `.git` entry and that `git -C ~/Documents/A1C/agent/tara-workspace ls-files | head` shows no `transcripts/`.
- [ ] **Step 3 (Mac A):** `node sync/sync.mjs` twice. Expected: all `ok`. Then `node sync/setup.mjs` to install the timer; `launchctl print gui/$(id -u)/com.agent-sync | grep -E 'state|runs'`.
- [ ] **Step 4 (Mac B):** clone `agentic-browser`, same config with `machine: "mac-b"`, run setup. Expected: hammock and tara `cloned` (or `merged` if folders exist), aside stores `merged`. Verify a note added on Mac A appears on Mac B within one interval.
- [ ] **Step 5 (Omarchy):** same, `machine: "omarchy"`; aside stores get `"mode": "pull"`, no `aside` flag, `workTree` `~/.local/share/agent-sync/aside-u0` and `-u3`. Expected: all `cloned`, then `ok` on each pass; `systemctl --user list-timers agent-sync.timer` shows it scheduled.
- [ ] **Step 6:** Tell Hammock (in `hammock-memory/memory/agent/environment.md`) that memory now syncs every five minutes, where `status.json` lives, and that a stopped store needs `--resume`.
