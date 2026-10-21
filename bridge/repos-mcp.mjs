#!/usr/bin/env node
/**
 * MCP server giving an agent push access to a few company repos without the token.
 *
 * Started by Claude Code from an mcp config, once per run. It reads the GitHub
 * token from a file only it can read; the agent only ever sees tool names. Which
 * repos, and how open each is, comes from repos.json next to the token (see
 * loadRepoConfig). See repos-tools.mjs for what each tool can and cannot do.
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { loadRepoConfig, toolsFor, callTool } from './repos-tools.mjs';

const CONFIG = process.env.REPOS_CONFIG_DIR || join(homedir(), '.config', 'agentic-browser-tara');
const expand = (p) => (p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);
const token = (await readFile(process.env.REPOS_TOKEN_FILE || join(CONFIG, 'github-token'), 'utf8')).trim();
if (!token) {
  console.error('repos-mcp: the token file is empty');
  process.exit(1);
}
const config = loadRepoConfig(await readFile(process.env.REPOS_FILE || join(CONFIG, 'repos.json'), 'utf8'));
const workRoot = process.env.REPOS_WORK_ROOT || (config.workRoot && expand(config.workRoot));
if (!workRoot) {
  console.error('repos-mcp: set workRoot in repos.json or REPOS_WORK_ROOT');
  process.exit(1);
}
const ctx = {
  token,
  config,
  gitRoot: process.env.REPOS_GIT_ROOT || join(CONFIG, 'git'),
  workRoot,
  // Set by the bridge on a teammate's turn, from Slack; empty on the operator's. Written into commits and PRs.
  requesterName: process.env.AGENT_REQUESTER_NAME || undefined,
};
const tools = toolsFor(config);

const server = new Server({ name: 'repos', version: '0.1.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async (req) => callTool(req.params.name, req.params.arguments || {}, ctx));
await server.connect(new StdioServerTransport());
