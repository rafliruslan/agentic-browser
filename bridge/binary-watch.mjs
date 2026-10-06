/**
 * Exit when the node binary this process runs from has been deleted.
 *
 * `brew upgrade` replaces node by installing the new version and deleting the
 * old one. A long-running bridge keeps going on the deleted binary, and macOS
 * then refuses it access to ~/Documents, where the workspace lives: every turn
 * fails with "An unknown error occurred (Unexpected)" and the transcript writes
 * fail with EPERM. It happened on 2026-09-25 and again on 2026-10-06, to both
 * agents, and each time it went unnoticed until someone asked why the agent had
 * stopped answering.
 *
 * Exiting is the whole fix. launchd's KeepAlive starts the process again, and
 * the new one resolves /opt/homebrew/bin/node to the binary that exists now. A
 * turn in flight at that moment was already failing, and the bridge reports
 * orphaned placeholders on startup.
 */
import { existsSync } from 'node:fs';

export const DEFAULT_INTERVAL_MS = 60 * 1000;

/** Whether the binary is gone. Separate so the decision is testable. */
export function binaryGone(execPath, exists = existsSync) {
  return Boolean(execPath) && !exists(execPath);
}

/**
 * Check once a minute; when the binary has gone, log and exit.
 *
 * The timer is unref'd so it never keeps an otherwise finished process alive.
 * Returns the timer so a test or a caller can stop it.
 */
export function watchOwnBinary({
  execPath = process.execPath,
  intervalMs = DEFAULT_INTERVAL_MS,
  exists = existsSync,
  log = console,
  exit = (code) => process.exit(code),
} = {}) {
  const timer = setInterval(() => {
    if (!binaryGone(execPath, exists)) return;
    clearInterval(timer);
    log.error?.(`[agent] node binary ${execPath} was deleted (likely brew upgrade); exiting so launchd restarts on the current node`);
    exit(0);
  }, intervalMs);
  timer.unref?.();
  return timer;
}
