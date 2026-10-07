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
