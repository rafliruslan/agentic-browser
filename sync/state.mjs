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
