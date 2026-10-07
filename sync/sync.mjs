#!/usr/bin/env node
/**
 * One sync pass over every store in sync.config.json, then exit. A launchd or
 * systemd timer runs it every few minutes; run it by hand to sync now.
 *
 *   node sync/sync.mjs                  one pass
 *   node sync/sync.mjs --resume <store> clear a stop after fixing its cause
 */
import { readFileSync, unlinkSync } from 'node:fs';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { acquire, release, isAlive } from '../bridge/lock.mjs';
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
  // The lock lives in this machine's own state folder, so a lock naming another
  // host is ours from before the host name changed (macOS renames itself with
  // the network). Cleared only when its process is gone: a pass still running
  // when the name changed keeps its lock.
  try {
    const held = JSON.parse(readFileSync(state.lockPath, 'utf8'));
    if (held.host && held.host !== hostname() && !isAlive(held.pid)) unlinkSync(state.lockPath);
  } catch { /* no lock, or unreadable: acquire decides */ }
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
