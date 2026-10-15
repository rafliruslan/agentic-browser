import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  detectService, jobName, sq, waiterScript, launchdPlist, schedule, parseArgs,
  parseLaunchctlList, ancestorPids,
} from './restart-self.mjs';

test('macOS: a run under a launchd job sees the job label', () => {
  const env = { XPC_SERVICE_NAME: 'com.agentic-browser.bridge' };
  assert.equal(detectService({ platform: 'darwin', env }), 'com.agentic-browser.bridge');
});

test('macOS: a terminal is not a service', () => {
  for (const name of [undefined, '', '0', 'application.com.mitchellh.ghostty.123.456']) {
    assert.equal(detectService({ platform: 'darwin', env: { XPC_SERVICE_NAME: name } }), null, String(name));
  }
});

// What the agent's Bash tool sees on macOS: no XPC_SERVICE_NAME, so the
// parent chain has to name the bridge.
const LIST = 'PID\tStatus\tLabel\n22120\t0\tcom.agentic-browser.bridge\n-\t0\tcom.example.idle\n2784\t0\tapplication.com.mitchellh.ghostty.1.2\n';

test('macOS: a run whose shell lost XPC_SERVICE_NAME finds the bridge among its parents', () => {
  const jobs = parseLaunchctlList(LIST);
  assert.equal(jobs.get('22120'), 'com.agentic-browser.bridge');
  assert.equal(jobs.size, 2, 'a job with no pid is not running');
  const got = detectService({ platform: 'darwin', env: {}, ancestors: ['900', '901', '22120', '1'], jobs });
  assert.equal(got, 'com.agentic-browser.bridge');
});

test('macOS: a terminal among the parents is not a bridge, and stops the search', () => {
  const jobs = parseLaunchctlList(LIST);
  assert.equal(detectService({ platform: 'darwin', env: {}, ancestors: ['900', '2784', '22120'], jobs }), null);
  assert.equal(detectService({ platform: 'darwin', env: {}, ancestors: ['900', '901'], jobs }), null);
});

test('ancestorPids walks ppid up to launchd', () => {
  const parent = { 900: '901', 901: '22120', 22120: '1' };
  const run = (cmd, args) => `  ${parent[args.at(-1)]}\n`;
  assert.deepEqual(ancestorPids(run, 900), ['900', '901', '22120']);
});

test('Linux: the unit comes from the cgroup path', () => {
  const cgroup = '0::/user.slice/user-1000.slice/user@1000.service/app.slice/agentic-browser.service\n';
  assert.equal(detectService({ platform: 'linux', cgroup }), 'agentic-browser.service');
});

test('Linux: a terminal scope and the user manager are not the bridge', () => {
  assert.equal(detectService({ platform: 'linux', cgroup: '0::/user.slice/user-1000.slice/session-2.scope\n' }), null);
  assert.equal(detectService({ platform: 'linux', cgroup: '0::/user.slice/user-1000.slice/user@1000.service\n' }), null);
  assert.equal(detectService({ platform: 'linux', cgroup: '' }), null);
});

test('each bridge gets its own one-shot job name', () => {
  assert.equal(jobName('com.agentic-browser.tara', 'darwin'), 'com.agentic-browser.tara.restart-self');
  assert.equal(jobName('agentic-browser.service', 'linux'), 'agentic-browser-restart-self');
});

test('sq survives a single quote', () => {
  assert.equal(execFileSync('/bin/sh', ['-c', `printf %s ${sq("it's")}`], { encoding: 'utf8' }), "it's");
});

test('--service names another bridge', () => {
  assert.deepEqual(parseArgs(['--service', 'com.agentic-browser.tara']), { service: 'com.agentic-browser.tara', help: false });
  assert.deepEqual(parseArgs([]), { service: undefined, help: false });
});

test('the launchd job runs once: KeepAlive false, RunAtLoad true', () => {
  const plist = launchdPlist({ label: 'x.restart-self', script: 'a && b < c', log: '/l' });
  assert.match(plist, /<key>KeepAlive<\/key>\s*<false\/>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /a &amp;&amp; b &lt; c/, 'the inline script is escaped');
  if (existsSync('/usr/bin/plutil')) {
    const dir = mkdtempSync(join(tmpdir(), 'restart-self-'));
    try {
      const path = join(dir, 'job.plist');
      writeFileSync(path, plist);
      execFileSync('/usr/bin/plutil', ['-lint', path]);
      const back = execFileSync('/usr/bin/plutil', ['-extract', 'ProgramArguments.2', 'raw', path], { encoding: 'utf8' });
      assert.equal(back.trim(), 'a && b < c');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

/**
 * Run the waiter script against stubs. `pid` is the bridge's pid now, `busy`
 * how many checks in a row find a child (or `checks`, one 1/0 per check, busy
 * or idle; idle once they run out), `comesBack` whether a restart yields a new
 * pid. Every stub call is appended to `calls`.
 */
function runWaiter(platform, { pid = '100', busy = 0, checks = null, comesBack = true, maxWait = 30 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'restart-self-'));
  const bin = join(dir, 'bin');
  const stub = (name, body) => {
    writeFileSync(join(bin, name), `#!/bin/sh\nS=${sq(dir)}\necho "${name} $*" >> "$S/calls"\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  try {
    execFileSync('mkdir', ['-p', bin]);
    writeFileSync(join(dir, 'pid'), pid);
    writeFileSync(join(dir, 'checks'), (checks ?? Array(busy).fill(1)).map((c) => `${c}\n`).join(''));
    const bump = comesBack ? 'echo $(( $(cat "$S/pid") + 1 )) > "$S/pid"' : ': > "$S/pid"';
    stub('pgrep', 'c=$(head -n 1 "$S/checks"); tail -n +2 "$S/checks" > "$S/rest"; mv "$S/rest" "$S/checks"; [ "$c" = 1 ]');
    stub('launchctl', [
      'case "$1" in',
      '  print) p=$(cat "$S/pid"); [ -n "$p" ] && printf "\\tpid = %s\\n\\tstate = running\\n" "$p"; exit 0;;',
      `  kickstart) ${bump};;`,
      'esac',
    ].join('\n'));
    stub('systemctl', [
      'case "$2" in',
      '  show) p=$(cat "$S/pid"); echo "${p:-0}";;',
      `  restart) ${bump};;`,
      'esac',
    ].join('\n'));
    const log = join(dir, 'restart-self.log');
    const plistPath = join(dir, 'job.plist');
    writeFileSync(plistPath, 'plist');
    const script = waiterScript({
      platform, service: 'com.example.bridge', uid: 501, log, plistPath,
      delay: 0, check: 1, maxWait, comeBack: 2,
    });
    execFileSync('/bin/sh', ['-c', script], { env: { PATH: `${bin}:/usr/bin:/bin` } });
    const calls = readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n');
    return {
      calls,
      log: existsSync(log) ? readFileSync(log, 'utf8') : '',
      plistLeft: existsSync(plistPath),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('macOS: an idle bridge is restarted once, then the job unloads itself', () => {
  const { calls, log, plistLeft } = runWaiter('darwin');
  assert.equal(calls.filter((c) => c.startsWith('launchctl kickstart')).length, 1);
  assert.ok(calls.includes('launchctl kickstart -k gui/501/com.example.bridge'));
  assert.equal(calls.at(-1), 'launchctl bootout gui/501/com.example.bridge.restart-self', 'unloads itself last');
  assert.match(log, /com\.example\.bridge: restarted, pid 100 -> 101/);
  assert.equal(plistLeft, false, 'the plist is removed');
});

test('a busy bridge is restarted only after its runs end', () => {
  const { calls, log } = runWaiter('darwin', { busy: 2 });
  const kick = calls.findIndex((c) => c.startsWith('launchctl kickstart'));
  const lastBusy = calls.map((c, i) => (c.startsWith('pgrep') ? i : -1)).filter((i) => i >= 0);
  assert.equal(lastBusy.length, 4, 'two busy checks, then two idle');
  assert.ok(kick > lastBusy.at(-1), 'restart comes after the idle checks');
  assert.match(log, /restarted, pid 100 -> 101/);
  assert.doesNotMatch(log, /still busy/);
});

test('a run that ends while the bridge is still posting does not trigger the restart', () => {
  // Idle for one check (the run's process just exited), then busy again (the
  // next queued run), then idle for good.
  const { calls } = runWaiter('darwin', { checks: [1, 0, 1, 0, 0] });
  const pg = calls.filter((c) => c.startsWith('pgrep')).length;
  assert.equal(pg, 5, 'one idle check is not enough');
  assert.equal(calls.filter((c) => c.startsWith('launchctl kickstart')).length, 1);
});

test('a bridge busy past the limit is restarted anyway, and says so', () => {
  const { calls, log } = runWaiter('darwin', { busy: 99, maxWait: 2 });
  assert.equal(calls.filter((c) => c.startsWith('launchctl kickstart')).length, 1);
  assert.match(log, /still busy after 2s, restarting anyway/);
});

test('a bridge that does not come back is logged, not hidden', () => {
  const { log } = runWaiter('darwin', { comesBack: false });
  assert.match(log, /restart sent, but no new pid after 2s/);
});

test('Linux: the unit is restarted once through systemctl', () => {
  const { calls, log } = runWaiter('linux');
  assert.equal(calls.filter((c) => c === 'systemctl --user restart com.example.bridge').length, 1);
  assert.ok(!calls.some((c) => c.startsWith('launchctl')));
  assert.match(log, /restarted, pid 100 -> 101/);
});

function fakeRun(fail = []) {
  const calls = [];
  const run = (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    if (fail.some((f) => calls.at(-1).startsWith(f))) throw new Error('exit 1');
    return cmd === 'systemctl' && args.includes('LoadState') ? 'loaded\n' : '';
  };
  return { run, calls };
}

test('macOS schedule: replaces an earlier one-shot and bootstraps a plist that cannot repeat', () => {
  const { run, calls } = fakeRun(['launchctl bootout']);
  const written = {};
  const { job, log } = schedule({
    service: 'com.agentic-browser.bridge', platform: 'darwin', uid: 501, dir: '/state',
    run, write: (p, t) => { written[p] = t; }, mkdir() {},
  });
  assert.equal(job, 'com.agentic-browser.bridge.restart-self');
  assert.equal(log, '/state/restart-self.log');
  assert.deepEqual(calls, [
    'launchctl print gui/501/com.agentic-browser.bridge',
    'launchctl bootout gui/501/com.agentic-browser.bridge.restart-self',
    'launchctl bootstrap gui/501 /state/com.agentic-browser.bridge.restart-self.plist',
  ]);
  const plist = written['/state/com.agentic-browser.bridge.restart-self.plist'];
  assert.match(plist, /<key>KeepAlive<\/key>\s*<false\/>/);
  assert.ok(!calls.some((c) => c.includes('submit')), 'never launchctl submit');
});

test('macOS schedule: an unknown label is refused before anything is loaded', () => {
  const { run, calls } = fakeRun(['launchctl print']);
  assert.throws(
    () => schedule({ service: 'com.nope', platform: 'darwin', uid: 501, dir: '/s', run, write() {}, mkdir() {} }),
    /no launchd job com\.nope/,
  );
  assert.equal(calls.length, 1);
});

test('Linux schedule: a transient unit that is collected when done', () => {
  const { run, calls } = fakeRun(['systemctl --user stop']);
  schedule({ service: 'agentic-browser.service', platform: 'linux', uid: 1000, dir: '/s', run, mkdir() {} });
  assert.equal(calls[0], 'systemctl --user show -p LoadState --value agentic-browser.service');
  assert.equal(calls[1], 'systemctl --user stop agentic-browser-restart-self.service');
  assert.ok(calls[2].startsWith('systemd-run --user --collect --unit=agentic-browser-restart-self /bin/sh -c '));
});
