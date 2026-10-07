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
      const diff = ok(['-c', 'core.quotepath=false', 'diff', '--cached', '--text', '-U0', '--no-color']);
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
      // Every commit about to leave, including ones an agent made by itself
      // without the sync: a token removed in a later commit is still in history.
      // `log -p` shows no diff for merge commits, so a token typed while
      // resolving a merge by hand is caught by the net diff instead.
      const q = ['-c', 'core.quotepath=false'];
      const leaving = [
        ...findSecrets(ok([...q, 'log', '-p', '--text', '-U0', '--no-color', '--format=', `${upstream}..HEAD`])),
        ...findSecrets(ok([...q, 'diff', '--text', '-U0', '--no-color', upstream, 'HEAD'])),
      ];
      if (leaving.length) {
        const list = [...new Set(leaving.map((h) => `${h.file} (${h.pattern})`))].join(', ');
        return stop(`possible secret in an unpushed commit: ${list}; rewrite those commits locally, ${RESUME(store.name)}`);
      }
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
