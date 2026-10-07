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
