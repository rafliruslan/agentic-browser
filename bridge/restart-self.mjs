#!/usr/bin/env node
/**
 * Restart a bridge from inside one of its own runs: once, after the run ends.
 *
 * An agent that edits its persona or the bridge code needs its bridge restarted
 * to pick the change up, and the run asking is a child of that bridge. Restart
 * it there and the run is cut off before it can reply. So the restart has to
 * happen later, from a process the bridge does not own.
 *
 * The agents used to improvise that with `launchctl submit`, and twice it went
 * wrong the same way. A submitted job is KeepAlive: when its command finishes,
 * launchd runs it again. "Sleep 30, then kickstart the bridge" became "kickstart
 * the bridge every 30 seconds", 579 times on 2026-10-07 and about 180 times on
 * 2026-10-14, and each restart cut off whatever the agent was doing. A note in
 * memory saying "end with launchctl remove" did not stop the second one.
 *
 * This schedules a job that cannot repeat. On macOS it is a plist with KeepAlive
 * false, so launchd runs it once and never again, and it unloads itself at the
 * end. On Linux it is a transient `systemd-run` unit, which has no restart
 * policy and is collected when it exits. The job is a plain shell script passed
 * inline, so it needs no file under ~/Documents, which macOS guards per binary.
 *
 * What the job does: wait DELAY_S so the reply can post, then wait until the
 * bridge has had no child process (no run in flight) for two checks in a row,
 * restart it, and log the old
 * and new pid. If the bridge stays busy for MAX_WAIT_S it restarts anyway; the
 * bridge reports a run cut off by a restart in its own thread.
 *
 *   node restart-self.mjs                     # the bridge this run belongs to
 *   node restart-self.mjs --service <label>   # another one, e.g. com.agentic-browser.tara
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DELAY_S = 40;
export const CHECK_S = 10;
export const MAX_WAIT_S = 30 * 60;
export const COME_BACK_S = 60;

const defaultRun = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

export const stateDir = (env = process.env) =>
  join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'agentic-browser');

/**
 * Which service this process runs under, or null.
 *
 * launchd puts the job label in XPC_SERVICE_NAME, but a run's shell does not
 * always keep it: the agent's Bash tool starts from a clean environment, and
 * there the variable is gone. So on macOS the parent chain decides as well:
 * the first ancestor that `launchctl list` names as a job is the bridge. A
 * terminal is "0" or "application.<bundle id>", neither of which is a job to
 * restart. Under systemd the unit is the last part of the cgroup path; a
 * terminal sits in a .scope, and user@N.service is the whole user manager,
 * never the bridge.
 *
 * `ancestors` is this process's parent pids, nearest first; `jobs` maps a pid
 * to its launchd label (see `parseLaunchctlList`).
 */
export function detectService({
  platform = process.platform,
  env = process.env,
  cgroup = '',
  ancestors = [],
  jobs = new Map(),
} = {}) {
  if (platform === 'darwin') {
    const isJob = (name) => !!name && name !== '0' && !name.startsWith('application.');
    if (isJob(env.XPC_SERVICE_NAME)) return env.XPC_SERVICE_NAME;
    for (const pid of ancestors) {
      const label = jobs.get(String(pid));
      if (label) return isJob(label) ? label : null;
    }
    return null;
  }
  const unit = /\/([^/\s]+\.service)\s*$/m.exec(cgroup)?.[1];
  return unit && !unit.startsWith('user@') ? unit : null;
}

/** `launchctl list` (PID, Status, Label) -> Map of running pid -> label. */
export function parseLaunchctlList(text) {
  const jobs = new Map();
  for (const line of String(text).split('\n')) {
    const [pid, , label] = line.trim().split(/\s+/);
    if (/^\d+$/.test(pid ?? '') && label) jobs.set(pid, label);
  }
  return jobs;
}

/** This process's parent pids, nearest first, up to (not including) launchd. */
export function ancestorPids(run = defaultRun, start = process.ppid) {
  const out = [];
  for (let pid = start; pid > 1 && out.length < 64; ) {
    out.push(String(pid));
    try { pid = Number(run('ps', ['-o', 'ppid=', '-p', String(pid)]).trim()); } catch { break; }
  }
  return out;
}

/** The label of the one-shot job, derived so two bridges never share one. */
export function jobName(service, platform = process.platform) {
  return platform === 'darwin'
    ? `${service}.restart-self`
    : `${service.replace(/\.service$/, '')}-restart-self`;
}

/** Single-quote for sh: close the quote, add an escaped quote, reopen. */
export const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * The shell program the one-shot job runs. Pure, so the waiting and the
 * restart can be tested against stub launchctl, systemctl and pgrep.
 */
export function waiterScript({
  platform = process.platform,
  service,
  uid = userInfo().uid,
  log,
  plistPath = '',
  delay = DELAY_S,
  check = CHECK_S,
  maxWait = MAX_WAIT_S,
  comeBack = COME_BACK_S,
}) {
  const darwin = platform === 'darwin';
  const lines = [
    `SERVICE=${sq(service)}`,
    `LOG=${sq(log)}`,
    `note() { echo "$(date '+%Y-%m-%d %H:%M:%S') $SERVICE: $*" >> "$LOG"; }`,
    ...(darwin
      ? [
          `DOMAIN=gui/${uid}`,
          `pid() { launchctl print "$DOMAIN/$SERVICE" 2>/dev/null | awk '$1=="pid"{print $3; exit}'; }`,
          `restart() { launchctl kickstart -k "$DOMAIN/$SERVICE"; }`,
          // Last, because unloading this job ends this script.
          `finish() { rm -f ${sq(plistPath)}; launchctl bootout "$DOMAIN/"${sq(jobName(service, platform))}; }`,
        ]
      : [
          `pid() { p=$(systemctl --user show -p MainPID --value "$SERVICE" 2>/dev/null); [ -n "$p" ] && [ "$p" != 0 ] && echo "$p"; }`,
          `restart() { systemctl --user restart "$SERVICE"; }`,
          // systemd-run --collect removes the unit when this exits.
          `finish() { :; }`,
        ]),
    `sleep ${delay}`,
    // Idle twice in a row, one check apart: a run that just ended (or was
    // killed for taking too long) leaves the bridge still posting its reply,
    // and a restart in that gap cuts the reply off.
    `old=$(pid); waited=0; idle=0`,
    `while :; do`,
    `  if [ -n "$old" ] && pgrep -P "$old" >/dev/null 2>&1; then idle=0; else idle=$((idle + 1)); fi`,
    `  if [ "$idle" -ge 2 ]; then break; fi`,
    `  if [ "$waited" -ge ${maxWait} ]; then note "still busy after \${waited}s, restarting anyway"; break; fi`,
    `  sleep ${check}; waited=$((waited + ${check})); old=$(pid)`,
    `done`,
    `restart`,
    `new=""; t=0`,
    `while [ "$t" -lt ${comeBack} ]; do`,
    `  sleep 1; t=$((t + 1)); new=$(pid)`,
    `  if [ -n "$new" ] && [ "$new" != "$old" ]; then break; fi`,
    `done`,
    `if [ -n "$new" ] && [ "$new" != "$old" ]; then note "restarted, pid \${old:-none} -> $new"`,
    `else note "restart sent, but no new pid after ${comeBack}s"; fi`,
    `finish`,
  ];
  return lines.join('\n') + '\n';
}

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * A launchd job that runs once. KeepAlive false is the point of this file:
 * `launchctl submit` implies KeepAlive true, which is what looped.
 */
export function launchdPlist({ label, script, log }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>${xml(script)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
  <key>StandardOutPath</key>
  <string>${xml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(log)}</string>
</dict>
</plist>
`;
}

/**
 * Check the service exists, replace any earlier one-shot for it, and start the
 * new one. Returns { job, log }. Throws with a readable message on failure.
 */
export function schedule({
  service,
  platform = process.platform,
  uid = userInfo().uid,
  dir = stateDir(),
  run = defaultRun,
  write = (path, text) => writeFileSync(path, text),
  mkdir = (path) => mkdirSync(path, { recursive: true }),
  ...timing
}) {
  const job = jobName(service, platform);
  const log = join(dir, 'restart-self.log');
  mkdir(dir);
  if (platform === 'darwin') {
    try { run('launchctl', ['print', `gui/${uid}/${service}`]); }
    catch { throw new Error(`no launchd job ${service} in gui/${uid}`); }
    const plistPath = join(dir, `${job}.plist`);
    const script = waiterScript({ platform, service, uid, log, plistPath, ...timing });
    // A finished one-shot unloads itself; one still waiting is replaced, and
    // the new one does the same work.
    try { run('launchctl', ['bootout', `gui/${uid}/${job}`]); } catch {}
    write(plistPath, launchdPlist({ label: job, script, log }));
    run('launchctl', ['bootstrap', `gui/${uid}`, plistPath]);
  } else {
    const state = run('systemctl', ['--user', 'show', '-p', 'LoadState', '--value', service]).trim();
    if (state !== 'loaded') throw new Error(`no systemd user unit ${service} (LoadState ${state || 'unknown'})`);
    const script = waiterScript({ platform, service, uid, log, ...timing });
    try { run('systemctl', ['--user', 'stop', `${job}.service`]); } catch {}
    run('systemd-run', ['--user', '--collect', `--unit=${job}`, '/bin/sh', '-c', script]);
  }
  return { job, log };
}

export function parseArgs(argv) {
  const i = argv.indexOf('--service');
  return { service: i >= 0 ? argv[i + 1] : undefined, help: argv.includes('--help') || argv.includes('-h') };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('usage: restart-self.mjs [--service <launchd label | systemd unit>]');
    return 0;
  }
  let cgroup = '';
  let ancestors = [];
  let jobs = new Map();
  if (process.platform !== 'darwin') {
    try { cgroup = readFileSync('/proc/self/cgroup', 'utf8'); } catch {}
  } else if (!args.service) {
    ancestors = ancestorPids();
    try { jobs = parseLaunchctlList(defaultRun('launchctl', ['list'])); } catch {}
  }
  const service = args.service || detectService({ cgroup, ancestors, jobs });
  if (!service) {
    console.error('restart-self: not running under a bridge service. Pass --service <label>.');
    return 2;
  }
  try {
    const { log } = schedule({ service });
    console.log(
      `Scheduled: ${service} restarts in about ${DELAY_S}s, once no run is in progress. ` +
      `This run will finish first. The result goes to ${log}.`,
    );
    return 0;
  } catch (err) {
    console.error(`restart-self: ${err.message}`);
    return 1;
  }
}

const isMain = () => {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
};
if (process.argv[1] && isMain()) process.exit(main());
