#!/usr/bin/env node
/**
 * memory: ranked search over the agent's own memory files.
 *
 * Aside gained `memory_search` in 1.26. The agent has always been able to Grep
 * and Read `memory/`, so this is not new capability so much as new economics:
 * one call that returns two paragraphs instead of a Grep, a decision, and a
 * Read of a whole file to reach them.
 *
 * It is a SEPARATE server on purpose. browser-repl is listed only in the Brave
 * config, so a tool added there would exist on Linux and silently not on
 * macOS - and the whole point of matching Aside here is that the persona reads
 * the same on both machines. This server goes in mcp.json AND mcp.aside.json.
 *
 * It touches no browser, so unlike the other servers it still answers when the
 * browser is down, which is exactly when someone is asking the agent what
 * happened.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { search, render } from './search.mjs';

/**
 * The agent's cwd IS the workspace (bridge/index.mjs spawns it there), so the
 * default needs no configuration. AGENT_MEMORY_DIR overrides it for anyone
 * running this server from somewhere else.
 */
const ROOT = resolve(
  process.env.AGENT_MEMORY_DIR ||
    (process.env.AGENT_WORKSPACE ? join(process.env.AGENT_WORKSPACE, 'memory') : join(process.cwd(), 'memory')),
);

/** Every markdown file under ROOT, as {path, text} with paths relative to it. */
async function load(dir = ROOT, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out; // No memory directory yet is a normal state, not an error.
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      await load(full, out);
    } else if (entry.name.endsWith('.md')) {
      out.push({ path: relative(ROOT, full), text: await readFile(full, 'utf8').catch(() => '') });
    }
  }
  return out;
}

const TOOLS = [
  {
    name: 'search',
    description:
      'Ranked search over the agent\'s memory files, returning the matching SECTIONS rather than whole files. Use it before Grep or Read whenever the question is "what do I already know about X" - it is one call instead of grep-then-read, and it returns the two paragraphs that matter instead of the file they live in. Matching is lexical, not semantic: it finds the words you pass and words in the heading and path, so search the terms the notes would use, not a paraphrase. Read the file directly when you need the whole thing.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'Words to match. Two or three specific ones beat a sentence.' },
        limit: { type: 'number', default: 5, description: 'Maximum sections to return.' },
      },
    },
  },
];

const server = new Server({ name: 'memory', version: '0.1.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  if (name !== 'search') {
    return { content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true };
  }
  try {
    const files = await load();
    if (files.length === 0) {
      return { content: [{ type: 'text', text: `No memory files under ${ROOT}.` }] };
    }
    const hits = search(files, args.query, { limit: args.limit ?? 5 });
    if (hits.length === 0) {
      // Say where it looked. "Nothing found" against the wrong directory looks
      // exactly like "nothing found" against the right one.
      return {
        content: [{ type: 'text', text: `No match for "${args.query}" in ${files.length} files under ${ROOT}.` }],
      };
    }
    return { content: [{ type: 'text', text: hits.map(render).join('\n\n') }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `memory search failed: ${err.message}` }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
