#!/usr/bin/env node
/**
 * See past agent sessions, and get the command to resume one.
 *
 * Slack threads have been the only way to look at what the agent did, and they
 * are a poor list: no overview, and a thread scrolls away. The sessions
 * themselves are Claude Code transcripts under ~/.claude/projects, keyed by the
 * same ids the bridge already computes from a thread ts.
 *
 * Read-only. It writes nothing, resumes nothing, and starts no browser.
 *
 *   node bridge/sessions-cli.mjs            # 20 most recent
 *   node bridge/sessions-cli.mjs -n 50
 *   node bridge/sessions-cli.mjs --json
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { summarise, threadIndex, relativeAge, chooseTranscripts } from './transcript.mjs';
import { DEFAULT_STATE_PATH } from './sessions.mjs';
import { transcriptPathFor } from './mirror.mjs';
import { readIndex, groupBySession, readRange, indexPathIn } from './runs-index.mjs';

const WORKSPACE = process.env.AGENT_WORKSPACE
  || join(homedir(), '.local', 'share', 'agentic-browser', 'workspace');

/**
 * Claude Code stores a project's transcripts under a slug of its cwd, with
 * every non-alphanumeric run replaced by a dash. The bridge runs the agent with
 * cwd = the workspace, so that path is what identifies the sessions.
 *
 * Only a fallback now. The bridge mirrors its own transcripts, and this is
 * where the sessions that predate it still live.
 */
function projectDir(cwd) {
  return join(homedir(), '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
}

/** The .jsonl files in a directory, as full paths, or none if it is absent. */
async function transcriptsIn(dir) {
  try {
    return (await readdir(dir))
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

/** Every session to list, ours preferred over Claude Code's. */
async function sources(workspace) {
  return chooseTranscripts({
    mine: await transcriptsIn(join(workspace, 'transcripts')),
    theirs: await transcriptsIn(projectDir(workspace)),
  });
}

/**
 * A Slack permalink. The workspace host is not in the transcript, so it comes
 * from SLACK_WORKSPACE when set; without it the archives path still opens from
 * any signed-in Slack.
 */
function permalink({ channel, threadTs }) {
  const host = process.env.SLACK_WORKSPACE || 'app';
  return `https://${host}.slack.com/archives/${channel}/p${threadTs.replace('.', '')}`;
}

function parseArgs(argv) {
  const out = { limit: 20, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '-n' || a === '--limit') out.limit = Number(argv[++i]) || out.limit;
    else if (a === '-h' || a === '--help') out.help = true;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('usage: sessions-cli.mjs [-n LIMIT] [--json]');
    return;
  }

  const found = await sources(WORKSPACE);
  if (found.size === 0) {
    console.error(`No sessions found. Looked in ${join(WORKSPACE, 'transcripts')}`);
    console.error(`and ${projectDir(WORKSPACE)}`);
    console.error(`(derived from AGENT_WORKSPACE=${WORKSPACE})`);
    process.exit(1);
  }

  let threads = {};
  try {
    threads = JSON.parse(await readFile(DEFAULT_STATE_PATH, 'utf8'));
  } catch {
    // The store prunes after a week and may not exist at all. Sessions still
    // list; they just lose their Slack link.
  }
  const index = threadIndex(threads);

  // Where each turn's bytes are, for the transcripts we wrote ourselves.
  // Claude Code's have no index, so those still read whole.
  const runs = groupBySession(await readIndex(indexPathIn(WORKSPACE)));

  const rows = [];
  for (const [id, { path, source }] of found) {
    const { mtimeMs } = await stat(path);
    const turnsOf = runs.get(id);

    // The task line lives in the first turn, so read that turn and nothing
    // else. Reading the whole file to render 100 characters was the thing
    // worth fixing, and it only gets worse the longer a thread runs.
    const text = turnsOf?.length
      ? await readRange(path, turnsOf[0].offset, turnsOf[0].bytes)
      : await readFile(path, 'utf8').catch(() => '');
    const s = summarise(id, text);

    // How many times the agent ran, which is what a turn is. Counting
    // assistant messages showed "183 turns" for a session that had run five
    // times. Only the indexed sessions can know this; the rest keep the count
    // summarise derives.
    const turns = turnsOf?.length ?? s.turns;

    // Prefer the channel and thread the prompt names: it carries the channel
    // too, and it survives threads.json's weekly prune. The hash index is the
    // fallback for a transcript whose prompt did not say.
    const threadTs = s.slack?.threadTs || index[id] || null;
    rows.push({ ...s, turns, when: mtimeMs, threadTs, source, channel: s.slack?.channel || null });
  }
  rows.sort((a, b) => b.when - a.when);
  const shown = rows.slice(0, args.limit);

  if (args.json) {
    console.log(JSON.stringify(shown, null, 2));
    return;
  }


  const age = (r) => relativeAge(r.when);
  const wAge = Math.max(...shown.map((r) => age(r).length));
  for (const r of shown) {
    console.log(
      `${age(r).padEnd(wAge)}  ${String(r.turns).padStart(3)} turns  ` +
      `${r.id.slice(0, 8)}  ${r.task || '(no task recorded)'}`,
    );
    if (r.channel && r.threadTs) {
      console.log(`${' '.repeat(wAge)}  ${permalink(r)}`);
    }
  }

  const ours = rows.filter((r) => r.source === 'bridge').length;
  console.log(`\n${shown.length} of ${rows.length} sessions`);
  console.log(`${ours} from ${join(WORKSPACE, 'transcripts')}, ${rows.length - ours} from ${projectDir(WORKSPACE)}`);
  console.log(`Resume one:  cd ${WORKSPACE} && claude --resume <id>`);
  // Said here rather than discovered later: the transcript is the same, the
  // authority is not. The bridge runs the agent with its own allowlist and
  // acceptEdits; a terminal resume runs as you, with your MCP config.
  console.log('That replays the same conversation as YOU, with your own MCP config');
  console.log('and permissions, not the bridge\'s tool allowlist.');
}

await main();
