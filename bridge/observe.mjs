#!/usr/bin/env node
/**
 * Observe how the user actually uses their browser, and reduce it to patterns.
 *
 * The agent's own transcripts only show what it was asked to do. The browser
 * shows what the user does when nobody asked anything, which is where the real
 * shape of someone's work is: which tools they live in, when they work, what
 * they keep coming back to, what is new this week.
 *
 * Deliberately aggregate. This emits domains, counts, hours and a handful of
 * recurring page titles, never a URL log. Two reasons:
 *
 *   1. Whatever this produces ends up in a memory file that an agent reads while
 *      also reading arbitrary web pages. A full browsing history sitting in that
 *      context is an exfiltration target. Domain counts are not.
 *   2. A log is not a pattern. "177 visits to Slack, concentrated 09:00-11:00"
 *      is a fact worth keeping; 847 timestamped URLs is something nobody, human
 *      or model, will read.
 *
 * Reads a copy of the SQLite file, because Brave holds a lock while running.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { homedir } from 'node:os';

const run = promisify(execFile);

/**
 * Any Chromium history database. Aside is Chromium too, so the same query works
 * against `~/Library/Application Support/Aside/Default/History` on macOS
 * (verified: same `urls` and `visits` schema) with only this path changed.
 *
 * BRAVE_HISTORY_DB still works; it was the name before the agent drove anything
 * but Brave, and silently ignoring an already-configured machine's variable is
 * a worse trade than carrying one alias.
 */
const HISTORY =
  process.env.AGENT_HISTORY_DB ||
  process.env.BRAVE_HISTORY_DB ||
  join(homedir(), '.local', 'share', 'browser-profile', 'Default', 'History');

/** Chrome stores time as microseconds since 1601-01-01. */
const CHROME_EPOCH_OFFSET = 11644473600;

/** Hosts that say nothing about the user. */
const NOISE = /^(www\.google\.[a-z.]+|duckduckgo\.com|localhost|127\.0\.0\.1|newtab)$/i;

const PY = `
import sqlite3, shutil, tempfile, sys, collections, datetime, re
src, since_us = sys.argv[1], int(sys.argv[2])
tmp = tempfile.mktemp()
shutil.copy(src, tmp)
c = sqlite3.connect(tmp)

def host(u):
    m = re.match(r'https?://([^/]+)', u or '')
    return (m.group(1) if m else '').lower()

rows = c.execute("""
  select u.url, u.title, v.visit_time
  from visits v join urls u on u.id = v.url
  where v.visit_time > ?
""", (since_us,)).fetchall()

by_host = collections.Counter()
hours = collections.Counter()
titles = collections.defaultdict(collections.Counter)
days = set()

for url, title, t in rows:
    h = host(url)
    if not h: continue
    by_host[h] += 1
    secs = t/1_000_000 - ${CHROME_EPOCH_OFFSET}
    dt = datetime.datetime.fromtimestamp(secs)
    hours[dt.hour] += 1
    days.add(dt.date().isoformat())
    if title:
        titles[h][title.strip()[:70]] += 1

print("VISITS", len(rows))
print("DAYS", len(days), min(days) if days else '-', max(days) if days else '-')
print("HOURS", " ".join(f"{h}:{n}" for h, n in sorted(hours.items())))
for h, n in by_host.most_common(25):
    top = "; ".join(t for t, _ in titles[h].most_common(3))
    print(f"HOST\\t{n}\\t{h}\\t{top}")
`;

export async function observe(sinceMs = 0) {
  const sinceUs = sinceMs ? Math.round((sinceMs / 1000 + CHROME_EPOCH_OFFSET) * 1_000_000) : 0;
  const { stdout } = await run('python3', ['-c', PY, HISTORY, String(sinceUs)], {
    maxBuffer: 8 * 1024 * 1024,
  });

  const lines = stdout.trim().split('\n');
  const meta = {};
  const hosts = [];
  for (const l of lines) {
    if (l.startsWith('HOST\t')) {
      const [, n, host, top] = l.split('\t');
      if (NOISE.test(host)) continue;
      hosts.push({ host, visits: Number(n), titles: top || '' });
    } else {
      const [k, ...rest] = l.split(' ');
      meta[k] = rest.join(' ');
    }
  }
  return { meta, hosts };
}

/** Compact digest for the consolidation prompt. */
export function render({ meta, hosts }) {
  if (!hosts.length) return null;
  const busiest = (meta.HOURS || '')
    .split(' ')
    .map((x) => x.split(':').map(Number))
    .filter((p) => p.length === 2 && !Number.isNaN(p[0]))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([h, n]) => `${String(h).padStart(2, '0')}:00 (${n})`)
    .join(', ');

  const rows = hosts
    .slice(0, 20)
    .map((h) => `  ${String(h.visits).padStart(4)}  ${h.host}${h.titles ? `  : ${h.titles}` : ''}`)
    .join('\n');

  return [
    `Browser activity: ${meta.VISITS} visits across ${(meta.DAYS || '').split(' ')[0]} day(s).`,
    `Busiest hours: ${busiest}`,
    '',
    'Most-visited sites, with the page titles seen most often on each:',
    rows,
  ].join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const days = Number(process.argv[2] || 0);
  const since = days ? Date.now() - days * 86400000 : 0;
  observe(since)
    .then((d) => console.log(render(d) || 'no activity'))
    .catch((e) => {
      console.error('observe failed:', e.message);
      process.exit(1);
    });
}
