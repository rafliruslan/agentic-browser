/**
 * Which browser profile the agent is actually driving.
 *
 * A Chromium user-data-dir holds several profiles and the agent is pinned to
 * one by `--profile-directory`. Nothing told it which, so it could browse as a
 * different person from the one who asked and neither side would notice. On
 * this machine the two profiles are named "Personal" and "Work", the launcher
 * pins "Work", and the human uses "Personal"; the mismatch was found by hand
 * rather than reported.
 *
 * Aside's Gmail skill opens with the same warning from the other end: "ALWAYS
 * call googleAccounts.print() to identify the correct uid before using Gmail",
 * because a person's accounts are not interchangeable and picking the wrong one
 * fails quietly. This is the browser-level half of that - the part we can know
 * without asking any site.
 *
 * Reading only. It never selects a profile; choosing one is the launcher's job,
 * and a tool that could switch identity mid-session is a worse idea than the
 * confusion it would fix.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Profiles in a Chromium `Local State`, most recently used first.
 *
 * `active_time` is seconds since the epoch and is what tells the human's
 * profile from the agent's: the one a person has been typing in is the one
 * touched most recently.
 */
export function parseProfiles(localState) {
  const cache = localState?.profile?.info_cache;
  if (!cache || typeof cache !== 'object') return [];
  return Object.entries(cache)
    .map(([dir, info]) => ({
      dir,
      name: typeof info?.name === 'string' && info.name ? info.name : dir,
      // Sync is off here, so this is usually empty. Kept because when it is
      // set it is the single most useful thing on the record.
      account: info?.user_name || null,
      lastActive: Number(info?.active_time) || 0,
    }))
    .sort((a, b) => b.lastActive - a.lastActive);
}

/**
 * One line naming who the agent is, for the prompt and the startup log.
 *
 * Says the directory as well as the display name: two profiles can share a
 * name, and `--profile-directory` takes the directory.
 */
export function describeProfile(profiles, profileDir) {
  const found = profiles.find((p) => p.dir === profileDir);
  if (!found) return null;
  const account = found.account ? `, signed in as ${found.account}` : '';
  return `${found.name} (${found.dir})${account}`;
}

/**
 * Whether the agent is driving a profile the human is probably not in.
 *
 * Not an error: a deliberate split, one profile for work and one for the
 * person, is a good arrangement and is what this machine has. It is worth
 * SAYING though, because the failure it prevents is silent - the agent reads
 * an inbox, finds nothing, and reports nothing wrong.
 */
export function profileMismatch(profiles, profileDir) {
  if (profiles.length < 2 || !profileDir) return null;
  const mine = profiles.find((p) => p.dir === profileDir);
  const newest = profiles[0];
  if (!mine || !newest || newest.dir === profileDir) return null;
  return {
    driving: `${mine.name} (${mine.dir})`,
    humanLikelyIn: `${newest.name} (${newest.dir})`,
  };
}

/**
 * Read the identity of the profile this agent drives.
 *
 * Returns null when there is nothing to read, which is the normal case for a
 * browser driven through its own process rather than a user-data-dir - Aside
 * on macOS, for one. A missing answer must read as "not known", never as a
 * wrong answer.
 */
export async function readIdentity({ userDataDir, profileDir, read = readFile } = {}) {
  if (!userDataDir || !profileDir) return null;
  let parsed;
  try {
    parsed = JSON.parse(await read(join(userDataDir, 'Local State'), 'utf8'));
  } catch {
    return null;
  }
  const profiles = parseProfiles(parsed);
  const description = describeProfile(profiles, profileDir);
  if (!description) return null;
  return { description, mismatch: profileMismatch(profiles, profileDir), profiles };
}

/**
 * What the agent is told about who it is.
 *
 * Phrased as a fact and a caution rather than an instruction, because the
 * useful behaviour is that it checks WHICH account a site has it signed in as
 * before reporting an empty inbox as an empty inbox.
 */
export function identityNote(identity) {
  if (!identity) return '';
  const lines = [`You are browsing in the ${identity.description} profile.`];
  if (identity.mismatch) {
    lines.push(
      `This is not the profile he is using, which looks like ${identity.mismatch.humanLikelyIn}.` +
        ' A site may therefore have you signed in as someone else, or not at all.' +
        ' If what you find does not match what he described, say which account you were looking at' +
        ' rather than reporting nothing found.',
    );
  }
  return lines.join(' ');
}
