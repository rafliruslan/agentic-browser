/**
 * What Aside's own memory already holds, as text for the dream prompt.
 *
 * Aside runs its own dreaming and keeps its own notes. Two stores that both learn
 * the same fact drift apart, so the dream is shown Aside's briefing files and the
 * list of its pages and told not to restate them. Read only: the dream is never
 * handed a path inside Aside's folder, so it cannot edit it. The briefing files
 * are small by design. Episodic pages are left out of the list, since they are
 * dated logs and there is one for nearly every day.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const ASIDE_MEMORY =
  process.env.AGENT_ASIDE_MEMORY || join(homedir(), '.aside', 'u', '0', 'memory');

const MAX_FILE_CHARS = 5000;
const MAX_PAGES = 150;

async function pagesUnder(dir, base = dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'episodic') continue;
      out.push(...(await pagesUnder(full, base)));
    } else if (e.name.endsWith('.md')) {
      out.push(full.slice(base.length + 1));
    }
  }
  return out;
}

/** @returns {Promise<string|null>} null when Aside has no memory folder here */
export async function asideDigest(dir = ASIDE_MEMORY, maxFileChars = MAX_FILE_CHARS) {
  let pages;
  try {
    pages = (await pagesUnder(dir)).sort();
  } catch {
    return null;
  }

  const parts = [];
  for (const name of ['MEMORY.md', 'USER.md']) {
    let text;
    try {
      text = await readFile(join(dir, name), 'utf8');
    } catch {
      continue;
    }
    const cut = text.length > maxFileChars;
    parts.push(`--- ${name} ---\n${cut ? `${text.slice(0, maxFileChars)}\n[cut, ${text.length} characters in all]` : text}`);
  }

  const shown = pages.slice(0, MAX_PAGES);
  const more = pages.length > shown.length ? `\n[${pages.length - shown.length} more not listed]` : '';
  parts.push(`--- its other pages, by path (dated logs left out) ---\n${shown.join('\n')}${more}`);
  return parts.join('\n\n');
}
