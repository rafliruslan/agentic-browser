import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readlinkSync, realpathSync, existsSync, readFileSync, chmodSync } from 'node:fs';
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

test('setup stops on a git error instead of pushing an empty first copy', () => {
  const root = tmp();
  const remote = join(root, 'r.git');
  git(['init', '-q', '--bare', '-b', 'main', remote], { cwd: root });
  const work = join(root, 'w');
  mkdirSync(work);
  writeFileSync(join(work, 'locked.md'), 'x\n');
  chmodSync(join(work, 'locked.md'), 0o000);
  const store = { name: 'tara', workTree: work, gitDir: null, remote, branch: 'main', mode: 'readwrite', aside: false, relativeLinks: false };
  try {
    assert.throws(() => prepareStore(store, { machine: 't', state: createState(join(root, 'state')), log: () => {} }), /git add failed/);
    assert.equal(git(['ls-remote', '--heads', remote], { cwd: root }).stdout, '', 'nothing pushed');
  } finally {
    chmodSync(join(work, 'locked.md'), 0o644);
  }
});

test('cloning with a separate git dir creates its parent folder', () => {
  const r = rig();
  const target = join(r.root, 'fresh2');
  const store = r.store(target, { gitDir: join(r.root, 'deep', 'nested', 'g.git') });
  assert.equal(prepareStore(store, { machine: 'x', state: r.state('x'), log: () => {} }), 'cloned');
  assert.ok(existsSync(join(target, 'notes/a.md')));
});
