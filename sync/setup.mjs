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
  const hits = findSecrets(g(['-c', 'core.quotepath=false', 'diff', '--cached', '--text', '-U0', '--no-color']).stdout);
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
