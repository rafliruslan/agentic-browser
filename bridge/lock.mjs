/**
 * One bridge per machine.
 *
 * Socket Mode allows several concurrent connections and Slack delivers
 * `app_mention` to every one of them. Two bridges therefore answer every
 * mention twice, with two different agents reaching two different results in
 * the same thread. The failure is invisible from the outside: nothing errors,
 * the user just sees the agent contradict itself and assumes it is flaky.
 *
 * systemd already prevents two copies of the same unit. It does not prevent a
 * hand-run `node index.mjs` beside the service, which is exactly what happens
 * while developing, so this covers that case.
 *
 * A dead holder must never block a restart, so the lock records a pid and is
 * taken over when that pid is gone. `process.kill(pid, 0)` sends no signal, it
 * only asks whether the process exists.
 *
 * That question is not the one we need answered. It proves SOME process has
 * that pid, not that it is the bridge. Pids are reassigned across a reboot, so
 * a lock left behind by a killed bridge gets adopted by whatever inherits its
 * number. This bridge sat down for three days because pid 1018 came back as an
 * Apple XPC service 36 seconds after boot, and launchd retried against it every
 * 30 seconds, refusing to start each time. Hence the boot-time check: a lock
 * taken before this boot cannot have a live holder, whatever its pid says now.
 */
import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir, hostname, uptime } from 'node:os';

export const DEFAULT_LOCK_PATH = join(
  homedir(), '.local', 'state', 'agentic-browser', 'bridge.lock',
);

/** True if a process with this pid exists and we may signal it. */
export function isAlive(pid, kill = process.kill) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to another user, so it is alive.
    return err.code === 'EPERM';
  }
}

/**
 * Roughly when this machine booted, in ms since the epoch.
 *
 * From `os.uptime()` rather than `sysctl kern.boottime`, because this runs on
 * Linux and macOS and uptime is the same call on both.
 */
export function bootTime(now = Date.now(), up = uptime) {
  return now - up() * 1000;
}

/**
 * Grace for the boot-time comparison. Uptime is a rounded number of seconds and
 * a lock can be written in the first moments after boot, so a strict comparison
 * would occasionally call a live lock stale.
 *
 * The two mistakes are not symmetric, which is why the grace exists and why it
 * points this way. Wrongly "held" stops the bridge starting, and someone sees a
 * clear line in the log saying so. Wrongly "stale" starts a second bridge, and
 * then Slack delivers every mention to both and two agents answer the same
 * thread with two different results, erroring nowhere.
 */
const BOOT_GRACE_MS = 60_000;

/**
 * Is this lock still held by someone else?
 *
 * Pure, so the awkward cases can be tested without rebooting anything.
 */
export function stillHeld(
  held,
  { pid = process.pid, alive = isAlive, boot = bootTime(), host = hostname() } = {},
) {
  if (!held || held.pid === pid) return false;

  // A lock from another machine, which happens when ~ is shared. Neither test
  // below means anything across a network: the local process table is about
  // the wrong computer, and our uptime says nothing about theirs. Nothing here
  // can prove it dead, so it stays held, and a human clears the file. That is
  // the safe half of the asymmetry - see BOOT_GRACE_MS. An older lock with no
  // host recorded is judged on pid and boot alone, as before.
  if (held.host && host && held.host !== host) return true;

  // A lock older than this boot is a corpse regardless of who holds its pid now.
  // An unparseable or absent timestamp means an older lock file, and refusing
  // to start on those would be a worse bug than the one this fixes: fall back
  // to the pid check.
  const since = Date.parse(held.since);
  if (Number.isFinite(since) && since < boot - BOOT_GRACE_MS) return false;

  return alive(held.pid);
}

/**
 * Claim the lock. Returns { ok: true } on success, or { ok: false, holder }
 * naming who has it, so the caller can log something useful and exit.
 */
export async function acquire({ path = DEFAULT_LOCK_PATH, pid = process.pid, alive = isAlive } = {}) {
  let held = null;
  try {
    held = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    // Absent or unreadable, treat as free.
  }

  if (stillHeld(held, { pid, alive })) {
    return { ok: false, holder: held };
  }

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({
    pid, host: hostname(), since: new Date().toISOString(),
  }, null, 2));
  return { ok: true, tookOver: Boolean(held && held.pid !== pid) };
}

/** Release the lock, but never another process's. */
export async function release({ path = DEFAULT_LOCK_PATH, pid = process.pid } = {}) {
  try {
    const held = JSON.parse(await readFile(path, 'utf8'));
    if (held.pid !== pid) return false;
    await unlink(path);
    return true;
  } catch {
    return false;
  }
}
