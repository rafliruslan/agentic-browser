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
