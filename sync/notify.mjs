/** One desktop notification, best effort. */
import { spawnSync } from 'node:child_process';

export function notifyCommand(title, body, platform = process.platform) {
  if (platform === 'darwin') {
    return ['osascript', ['-e', `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`]];
  }
  if (platform === 'linux') return ['notify-send', [title, body]];
  return null;
}

export function notify(title, body) {
  const c = notifyCommand(title, body);
  if (c) spawnSync(c[0], c[1], { stdio: 'ignore', timeout: 5000 });
}
