import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRepoConfig, toolsFor, callTool, forbiddenHit, TOOL_NAMES } from './repos-tools.mjs';

const CONFIG = loadRepoConfig(JSON.stringify({
  _why: 'notes are ignored',
  org: 'example-org',
  author: { name: 'Tara (bot)', email: 'bot@users.noreply.github.com' },
  repos: {
    site: { base: 'develop', direct: true },
    'site-two': { base: 'development', direct: true },
    admin: { base: 'development', direct: false },
    api: { base: 'develop', direct: false },
    app: { base: 'development', direct: false },
    'partner-api': { base: 'development', direct: false },
  },
}));

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } }).trim();

// A local bare "origin" with main and develop, so no test touches GitHub.
function setup(preview = 'develop') {
  const dir = mkdtempSync(join(tmpdir(), 'repos-tools-'));
  const origin = join(dir, 'origin.git');
  const seed = join(dir, 'seed');
  mkdirSync(seed);
  sh(seed, 'init', '-q', '-b', 'main');
  writeFileSync(join(seed, 'index.html'), 'hello\n');
  sh(seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A');
  sh(seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'seed');
  sh(seed, 'branch', preview);
  sh(dir, 'clone', '-q', '--bare', seed, origin);
  const calls = [];
  const ctx = {
    config: CONFIG,
    token: 'sekret-token',
    gitRoot: join(dir, 'git'),
    workRoot: join(dir, 'work'),
    remoteUrl: () => `file://${origin}`,
    fetchFn: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 201, json: async () => ({ html_url: 'https://github.com/example-org/site/pull/99' }) };
    },
  };
  return { dir, origin, ctx, calls, work: join(dir, 'work', 'site') };
}
const heads = (origin) => sh(origin, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').sort();

test('the toolset has no delete or force tool, and every tool takes a repo', () => {
  const tools = toolsFor(CONFIG);
  assert.deepEqual(tools.map((t) => t.name).sort(), [...TOOL_NAMES].sort());
  assert.ok(!tools.some((t) => /delete|force|remove/i.test(t.name)));
  for (const t of tools) assert.ok(t.inputSchema.required.includes('repo'));
  // The descriptions come from the config, so the agent sees its real choices.
  assert.match(tools[0].inputSchema.properties.repo.description, /^One of: site, site-two, admin, api, app, partner-api$/);
  assert.match(tools.find((t) => t.name === 'push').description, /work on site, site-two only/);
});

test('a repos config that is missing anything or odd is refused', () => {
  const good = { org: 'o', author: { name: 'A', email: 'a@b' }, repos: { r: { base: 'develop', direct: false } } };
  assert.doesNotThrow(() => loadRepoConfig(JSON.stringify(good)));
  const bad = [
    { ...good, org: '' },
    { ...good, org: '../x' },
    { ...good, author: { name: 'A' } },
    { ...good, author: { name: ' ', email: 'a@b' } },
    { ...good, repos: {} },
    { ...good, repos: { '../r': { base: 'develop', direct: false } } },
    { ...good, repos: { 'r.git': { base: 'develop', direct: false } } },
    { ...good, repos: { r: { base: 'main', direct: true } } },
    { ...good, repos: { r: { base: '--all', direct: true } } },
    { ...good, repos: { r: { base: 'develop', direct: 'yes' } } },
  ];
  for (const c of bad) assert.throws(() => loadRepoConfig(JSON.stringify(c)), JSON.stringify(c));
  assert.throws(() => loadRepoConfig('not json'));
});

test('start, edit, push and open a PR: only a tara/ branch reaches origin, main and develop stay put', async () => {
  const { dir, origin, ctx, calls, work } = setup();
  const before = sh(origin, 'rev-parse', 'develop');
  const r1 = await callTool('start_branch', { repo: 'site', name: 'seo-faq' }, ctx);
  assert.equal(r1.isError, undefined, r1.content[0].text);
  writeFileSync(join(work, 'index.html'), 'changed\n');
  writeFileSync(join(work, 'new.txt'), 'new\n');
  const st = await callTool('status', { repo: 'site', diff: true }, ctx);
  assert.match(st.content[0].text, /tara\/seo-faq/);
  const r2 = await callTool('push', { repo: 'site', message: 'Fix FAQ' }, ctx);
  assert.equal(r2.isError, undefined, r2.content[0].text);
  assert.deepEqual(heads(origin), ['develop', 'main', 'tara/seo-faq']);
  assert.equal(sh(origin, 'rev-parse', 'develop'), before);
  assert.equal(sh(origin, 'show', 'tara/seo-faq:index.html'), 'changed');
  assert.equal(sh(origin, 'log', '-1', '--format=%an', 'tara/seo-faq'), 'Tara (bot)');
  const r3 = await callTool('open_pr', { repo: 'site', title: 'Fix FAQ', body: 'why' }, ctx);
  assert.match(r3.content[0].text, /pull\/99/);
  const sent = JSON.parse(calls[0].init.body);
  assert.deepEqual([sent.head, sent.base], ['tara/seo-faq', 'develop']);
  rmSync(dir, { recursive: true });
});

test('a second start is cut from develop and refuses unsaved changes unless discard is set', async () => {
  const { dir, ctx, work } = setup();
  await callTool('start_branch', { repo: 'site', name: 'one' }, ctx);
  writeFileSync(join(work, 'index.html'), 'unsaved\n');
  const refused = await callTool('start_branch', { repo: 'site', name: 'two' }, ctx);
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /unsaved changes/);
  const ok = await callTool('start_branch', { repo: 'site', name: 'two', discard: true }, ctx);
  assert.equal(ok.isError, undefined, ok.content[0].text);
  assert.equal(readFileSync(join(work, 'index.html'), 'utf8'), 'hello\n');
  rmSync(dir, { recursive: true });
});

test('it will not push when the work tree is not on a tara/ branch, even if the agent moved it', async () => {
  const { dir, origin, ctx, work } = setup();
  await callTool('start_branch', { repo: 'site', name: 'x' }, ctx);
  // Simulate the agent rewriting the work tree's .git file to a repo of its own.
  const own = join(dir, 'own');
  mkdirSync(own);
  sh(own, 'init', '-q', '-b', 'main');
  writeFileSync(join(work, '.git'), `gitdir: ${join(own, '.git')}\n`);
  sh(join(dir, 'git', 'site.git'), 'checkout', '-q', '--detach');
  writeFileSync(join(work, 'index.html'), 'x\n');
  const r = await callTool('push', { repo: 'site', message: 'm' }, ctx);
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /only tara\/ branches/);
  assert.deepEqual(heads(origin), ['develop', 'main']);
  rmSync(dir, { recursive: true });
});

test('workflow, env and key files are refused, and nothing is committed', async () => {
  for (const f of ['.github/workflows/x.yml', '.env', 'sub/.env.local', 'deploy.pem']) {
    const { dir, origin, ctx, work } = setup();
    await callTool('start_branch', { repo: 'site', name: 'bad' }, ctx);
    mkdirSync(join(work, f, '..'), { recursive: true });
    writeFileSync(join(work, f), 'x\n');
    const r = await callTool('push', { repo: 'site', message: 'm' }, ctx);
    assert.equal(r.isError, true, f);
    assert.match(r.content[0].text, /Refusing/);
    assert.deepEqual(heads(origin), ['develop', 'main'], f);
    rmSync(dir, { recursive: true });
  }
});

test('a push with no change is refused', async () => {
  const { dir, ctx } = setup();
  await callTool('start_branch', { repo: 'site', name: 'empty' }, ctx);
  const r = await callTool('push', { repo: 'site', message: 'm' }, ctx);
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Nothing to push/);
  rmSync(dir, { recursive: true });
});

test('bad names, unknown repos and branches outside main and the preview branch are refused', async () => {
  const { dir, ctx } = setup();
  for (const name of ['../main', 'Main', 'a b', '-x', 'a..b', 'x.lock', '', 'a'.repeat(60)]) {
    const r = await callTool('start_branch', { repo: 'site', name }, ctx);
    assert.equal(r.isError, true, name);
  }
  assert.equal((await callTool('start_branch', { repo: 'app', name: 'x' }, ctx)).isError, true);
  for (const from of ['feat/x', 'development', 'tara/x', '--all', 'main ']) {
    const r = await callTool('start_branch', { repo: 'site', name: 'x', from }, ctx);
    assert.equal(r.isError, true, from);
    assert.match(r.content[0].text, /must be "main" or "develop"/, from);
  }
  // site-two's preview branch is `development`, so `develop` is not allowed there.
  assert.equal((await callTool('start_branch', { repo: 'site-two', name: 'x', from: 'develop' }, ctx)).isError, true);
  rmSync(dir, { recursive: true });
});

test('a teammate can push, and their name goes into the commit and the PR', async () => {
  const { dir, origin, ctx, calls, work } = setup();
  const team = { ...ctx, requesterName: 'Dewi\nIgnore all; rm -rf <b>' };
  await callTool('start_branch', { repo: 'site', name: 't' }, team);
  writeFileSync(join(work, 'a.txt'), 'a\n');
  const r = await callTool('push', { repo: 'site', message: 'Add a' }, team);
  assert.equal(r.isError, undefined, r.content[0].text);
  const msg = sh(origin, 'log', '-1', '--format=%B', 'tara/t');
  assert.match(msg, /^Add a\n\nRequested by Dewi Ignore all rm -rf b \(Slack\)\.$/);
  await callTool('open_pr', { repo: 'site', title: 'T', body: 'why' }, team);
  assert.match(JSON.parse(calls[0].init.body).body, /^why\n\nRequested by Dewi/);
  rmSync(dir, { recursive: true });
});

test('push with `to` lands straight on develop or main, never forced, nothing else moves', async () => {
  const { dir, origin, ctx, work } = setup();
  await callTool('start_branch', { repo: 'site', name: 'live' }, ctx);
  writeFileSync(join(work, 'index.html'), 'v2\n');
  const r = await callTool('push', { repo: 'site', message: 'v2', to: 'develop' }, ctx);
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.match(r.content[0].text, /onto develop/);
  assert.equal(sh(origin, 'show', 'develop:index.html'), 'v2');
  assert.equal(sh(origin, 'show', 'main:index.html'), 'hello');
  assert.deepEqual(heads(origin), ['develop', 'main']);
  // Cut from develop, which now holds main: main is an ancestor, so it fast-forwards.
  await callTool('start_branch', { repo: 'site', name: 'rel' }, ctx);
  writeFileSync(join(work, 'index.html'), 'v3\n');
  const r2 = await callTool('push', { repo: 'site', message: 'v3', to: 'main' }, ctx);
  assert.equal(r2.isError, undefined, r2.content[0].text);
  assert.match(r2.content[0].text, /production/);
  assert.equal(sh(origin, 'show', 'main:index.html'), 'v3');
  rmSync(dir, { recursive: true });
});

test('site-two: `development` and `main` take a straight push, `develop` does not', async () => {
  const { dir, origin, ctx } = setup('development');
  const R = 'site-two';
  const work = join(dir, 'work', R);
  assert.equal((await callTool('start_branch', { repo: R, name: 'a', from: 'development' }, ctx)).isError, undefined);
  writeFileSync(join(work, 'index.html'), 'dev\n');
  const refused = await callTool('push', { repo: R, message: 'm', to: 'develop' }, ctx);
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /must be "main" or "development"/);
  const r = await callTool('push', { repo: R, message: 'dev', to: 'development' }, ctx);
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.equal(sh(origin, 'show', 'development:index.html'), 'dev');
  assert.equal(sh(origin, 'show', 'main:index.html'), 'hello');
  await callTool('start_branch', { repo: R, name: 'b' }, ctx);
  writeFileSync(join(work, 'index.html'), 'prod\n');
  assert.equal((await callTool('push', { repo: R, message: 'prod', to: 'main' }, ctx)).isError, undefined);
  assert.equal(sh(origin, 'show', 'main:index.html'), 'prod');
  assert.deepEqual(heads(origin), ['development', 'main']);
  rmSync(dir, { recursive: true });
});

test('product repos: branch and PR only, no straight push, no main, no merge', async () => {
  for (const [R, preview] of [['api', 'develop'], ['admin', 'development'], ['app', 'development'], ['partner-api', 'development']]) {
    const { dir, origin, ctx, calls } = setup(preview);
    const work = join(dir, 'work', R);
    const ok = await callTool('start_branch', { repo: R, name: 'feat' }, ctx);
    assert.equal(ok.isError, undefined, `${R}: ${ok.content[0].text}`);
    assert.match(ok.content[0].text, new RegExp(`cut from ${preview}`));
    writeFileSync(join(work, 'index.html'), 'edit\n');
    writeFileSync(join(work, '.env.example'), 'KEY=\n');
    // Straight push, even to the preview branch, is refused and nothing is committed.
    for (const to of ['main', preview]) {
      const r = await callTool('push', { repo: R, message: 'm', to }, ctx);
      assert.equal(r.isError, true, `${R} to ${to}`);
      assert.match(r.content[0].text, /branches and pull requests only/);
    }
    assert.deepEqual(heads(origin), [preview, 'main'].sort());
    // main is not a base or a source either.
    assert.equal((await callTool('start_branch', { repo: R, name: 'x', from: 'main', discard: true }, ctx)).isError, true);
    // The branch route works, and `.env.example` is allowed while `.env.local` is not.
    const pushed = await callTool('push', { repo: R, message: 'edit' }, ctx);
    assert.equal(pushed.isError, undefined, pushed.content[0].text);
    assert.deepEqual(heads(origin), [preview, 'main', 'tara/feat'].sort());
    assert.equal(sh(origin, 'show', 'tara/feat:.env.example'), 'KEY=');
    const pr = await callTool('open_pr', { repo: R, title: 'T' }, ctx);
    assert.equal(pr.isError, undefined, pr.content[0].text);
    assert.equal(JSON.parse(calls[0].init.body).base, preview);
    const toMain = await callTool('open_pr', { repo: R, title: 'T', base: 'main' }, ctx);
    assert.equal(toMain.isError, true);
    assert.equal(calls.length, 1);
    // No merge, and no request reaches GitHub for it.
    const merge = await callTool('merge_pr', { repo: R, number: 5 }, ctx);
    assert.equal(merge.isError, true);
    assert.match(merge.content[0].text, /a person merges it/);
    assert.equal(calls.length, 1);
    // Listing is fine.
    assert.equal((await callTool('list_prs', { repo: R }, { ...ctx, fetchFn: async () => ({ ok: true, json: async () => [] }) })).isError, undefined);
    rmSync(dir, { recursive: true });
  }
});

test('env files other than .env.example are still refused', async () => {
  for (const f of ['.env.local', '.env.prd', 'app/.env', '.env']) {
    const { dir, origin, ctx, work } = setup();
    await callTool('start_branch', { repo: 'site', name: 'e' }, ctx);
    mkdirSync(join(work, f, '..'), { recursive: true });
    writeFileSync(join(work, f), 'S=1\n');
    const r = await callTool('push', { repo: 'site', message: 'm' }, ctx);
    assert.equal(r.isError, true, f);
    assert.deepEqual(heads(origin), ['develop', 'main'], f);
    rmSync(dir, { recursive: true });
  }
});

test('push to a branch that moved is refused, and the work stays on the tara branch', async () => {
  const { dir, origin, ctx, work } = setup();
  await callTool('start_branch', { repo: 'site', name: 'late' }, ctx);
  // Someone else lands a commit on develop first.
  const other = join(dir, 'other');
  sh(dir, 'clone', '-q', '-b', 'develop', origin, other);
  writeFileSync(join(other, 'x.txt'), 'x\n');
  sh(other, '-c', 'user.name=o', '-c', 'user.email=o@o', 'add', '-A');
  sh(other, '-c', 'user.name=o', '-c', 'user.email=o@o', 'commit', '-q', '-m', 'other');
  sh(other, 'push', '-q', 'origin', 'develop');
  const moved = sh(origin, 'rev-parse', 'develop');
  writeFileSync(join(work, 'index.html'), 'mine\n');
  const r = await callTool('push', { repo: 'site', message: 'mine', to: 'develop' }, ctx);
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /has moved/);
  assert.equal(sh(origin, 'rev-parse', 'develop'), moved);
  assert.equal(sh(join(dir, 'git', 'site.git'), 'log', '-1', '--format=%s', 'tara/late'), 'mine');
  rmSync(dir, { recursive: true });
});

test('push with `to` outside the two allowed branches is refused before it commits', async () => {
  const { dir, origin, ctx, work } = setup();
  await callTool('start_branch', { repo: 'site', name: 'bad' }, ctx);
  writeFileSync(join(work, 'index.html'), 'z\n');
  for (const to of ['feat/x', 'tara/other', 'development', '--force', 'refs/heads/main']) {
    const r = await callTool('push', { repo: 'site', message: 'm', to }, ctx);
    assert.equal(r.isError, true, to);
  }
  assert.deepEqual(heads(origin), ['develop', 'main']);
  assert.match(sh(join(dir, 'git', 'site.git'), 'log', '-1', '--format=%s', 'tara/bad'), /seed/);
  rmSync(dir, { recursive: true });
});

test('a branch cut from main pushes and opens a PR against main', async () => {
  const { dir, ctx, calls, work } = setup();
  await callTool('start_branch', { repo: 'site', name: 'fix', from: 'main' }, ctx);
  writeFileSync(join(work, 'index.html'), 'fix\n');
  assert.equal((await callTool('push', { repo: 'site', message: 'fix' }, ctx)).isError, undefined);
  await callTool('open_pr', { repo: 'site', title: 'Fix', base: 'main' }, ctx);
  assert.equal(JSON.parse(calls[0].init.body).base, 'main');
  const bad = await callTool('open_pr', { repo: 'site', title: 'Fix', base: 'feat/x' }, ctx);
  assert.equal(bad.isError, true);
  rmSync(dir, { recursive: true });
});

test('list_prs and merge_pr: only PRs into main or the preview branch, open, not draft, pinned to the read sha', async () => {
  const pr = (over) => ({ number: 7, state: 'open', merged: false, draft: false, title: 'T', head: { ref: 'tara/x', sha: 'a'.repeat(40), repo: { full_name: 'example-org/site' } }, base: { ref: 'develop' }, changed_files: 1, ...over });
  const make = (prObj, mergeResult = { ok: true, status: 200, json: async () => ({ sha: 'deadbeefcafe' }) }, files = [{ filename: 'index.html' }]) => {
    const calls = [];
    const fetchFn = async (url, init = {}) => {
      calls.push({ url, init });
      if (init.method === 'PUT') return mergeResult;
      if (url.includes('/compare/')) return { ok: true, status: 200, json: async () => ({ files }) };
      return { ok: true, status: 200, json: async () => (url.includes('?') ? [prObj] : prObj) };
    };
    return { calls, ctx: { config: CONFIG, token: 'sekret-token', gitRoot: '/nonexistent-git', workRoot: mkdtempSync(join(tmpdir(), 'repos-pr-')), fetchFn, requesterName: 'Dewi' } };
  };
  const list = make(pr());
  assert.match((await callTool('list_prs', { repo: 'site' }, list.ctx)).content[0].text, /#7 T \(tara\/x into develop\)/);

  const ok = make(pr());
  const r = await callTool('merge_pr', { repo: 'site', number: 7 }, ok.ctx);
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.match(r.content[0].text, /Merged PR #7 into develop \(deadbee\)/);
  const put = ok.calls.find((c) => c.init.method === 'PUT');
  // The files checked are those of the pinned commit, not whatever the PR holds later.
  assert.ok(ok.calls.some((c) => c.url.endsWith(`/repos/example-org/site/compare/develop...${'a'.repeat(40)}`)));
  assert.match(put.url, /\/pulls\/7\/merge$/);
  assert.deepEqual(JSON.parse(put.init.body), { merge_method: 'merge', sha: 'a'.repeat(40), commit_message: 'Requested by Dewi (Slack).' });

  const prod = await callTool('merge_pr', { repo: 'site', number: 7 }, make(pr({ base: { ref: 'main' } })).ctx);
  assert.match(prod.content[0].text, /production/);

  for (const [label, over] of [['other base', { base: { ref: 'feat/x' } }], ['closed', { state: 'closed' }], ['merged', { merged: true }], ['draft', { draft: true }]]) {
    const m = make(pr(over));
    const bad = await callTool('merge_pr', { repo: 'site', number: 7 }, m.ctx);
    assert.equal(bad.isError, true, label);
    assert.ok(!m.calls.some((c) => c.init.method === 'PUT'), label);
  }
  // A fork, or a PR touching what push would refuse, is left to a person.
  const fork = make(pr({ head: { ref: 'tara/x', sha: 'a'.repeat(40), repo: { full_name: 'someone/site' } } }));
  assert.match((await callTool('merge_pr', { repo: 'site', number: 7 }, fork.ctx)).content[0].text, /another repo/);
  assert.ok(!fork.calls.some((c) => c.init.method === 'PUT'));
  for (const files of [[{ filename: '.github/workflows/ci.yml' }], [{ filename: 'ci.yml', previous_filename: '.github/workflows/ci.yml' }], [{ filename: 'app/.env.prd' }]]) {
    // Count matches, so only the file rule can refuse it.
    const m = make(pr(), undefined, files);
    const r2 = await callTool('merge_pr', { repo: 'site', number: 7 }, m.ctx);
    assert.equal(r2.isError, true, JSON.stringify(files));
    assert.ok(!m.calls.some((c) => c.init.method === 'PUT'), JSON.stringify(files));
  }
  const many = make(pr({ changed_files: 300 }), undefined, Array.from({ length: 300 }, (_, i) => ({ filename: `f${i}` })));
  assert.match((await callTool('merge_pr', { repo: 'site', number: 7 }, many.ctx)).content[0].text, /every file/);
  // A list that is missing, or shorter than the PR says, is refused rather than read as clean.
  for (const [label, prOver, files] of [['no list', {}, null], ['short list', { changed_files: 2 }, [{ filename: 'a' }]], ['no count', { changed_files: undefined }, [{ filename: 'a' }]]]) {
    const m = make(pr(prOver), undefined, files);
    assert.equal((await callTool('merge_pr', { repo: 'site', number: 7 }, m.ctx)).isError, true, label);
    assert.ok(!m.calls.some((c) => c.init.method === 'PUT'), label);
  }
  assert.match((await callTool('merge_pr', { repo: 'site', number: 7 }, make(pr({ head: { ref: 'tara/x', sha: 'zz', repo: { full_name: 'example-org/site' } } })).ctx)).content[0].text, /no head commit/);
  for (const number of [0, -1, 1.5, '7', null, 1e9]) {
    assert.equal((await callTool('merge_pr', { repo: 'site', number }, make(pr()).ctx)).isError, true, String(number));
  }
  assert.equal((await callTool('merge_pr', { repo: 'site', number: 7, method: 'octopus' }, make(pr()).ctx)).isError, true);

  const refused = make(pr(), { ok: false, status: 405, json: async () => ({ message: 'Merge conflict sekret-token' }) });
  const conflict = await callTool('merge_pr', { repo: 'site', number: 7 }, refused.ctx);
  assert.equal(conflict.isError, true);
  assert.doesNotMatch(conflict.content[0].text, /sekret-token/);
});

test('a work tree that is a link out of the workspace is refused', async () => {
  const { dir, ctx } = setup();
  mkdirSync(ctx.workRoot, { recursive: true });
  mkdirSync(join(dir, 'elsewhere'));
  symlinkSync(join(dir, 'elsewhere'), join(ctx.workRoot, 'site'));
  const r = await callTool('start_branch', { repo: 'site', name: 'x' }, ctx);
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /not where it should be/);
  rmSync(dir, { recursive: true });
});

test('the token never appears in any result', async () => {
  const { dir, ctx, work } = setup();
  const out = [];
  out.push(await callTool('start_branch', { repo: 'site', name: 'tok' }, ctx));
  writeFileSync(join(work, 'a.txt'), 'a\n');
  out.push(await callTool('push', { repo: 'site', message: 'm' }, ctx));
  out.push(await callTool('open_pr', { repo: 'site', title: 't' }, { ...ctx, fetchFn: async () => ({ ok: false, status: 403, json: async () => ({ message: 'bad sekret-token' }) }) }));
  assert.doesNotMatch(JSON.stringify(out), /sekret-token/);
  rmSync(dir, { recursive: true });
});

test('env files: exactly .env.example passes, every other .env name and .envrc do not', () => {
  for (const ok of ['.env.example', 'app/.env.example', 'env.js', 'docs/environment.md']) assert.equal(forbiddenHit(ok), null, ok);
  for (const bad of ['.env', '.env.local', '.env.example.local', '.env.examples', 'app/.env.prd', '.envrc', 'sub/.envrc']) assert.ok(forbiddenHit(bad), bad);
});

test('moving a workflow file out of .github is refused, and nothing is committed', async () => {
  const { dir, origin, ctx, work } = setup();
  // Seed a workflow on develop, as a repo would have.
  const seed = join(dir, 'seed');
  sh(seed, 'checkout', '-q', 'develop');
  mkdirSync(join(seed, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(seed, '.github', 'workflows', 'ci.yml'), 'on: push\n');
  sh(seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A');
  sh(seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'ci');
  sh(seed, 'push', '-q', origin, 'develop');
  await callTool('start_branch', { repo: 'site', name: 'mv' }, ctx);
  renameSync(join(work, '.github', 'workflows', 'ci.yml'), join(work, 'ci.yml'));
  const r = await callTool('push', { repo: 'site', message: 'm' }, ctx);
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Refusing \.github\/workflows\/ci\.yml/);
  assert.deepEqual(heads(origin), ['develop', 'main']);
  rmSync(dir, { recursive: true });
});
