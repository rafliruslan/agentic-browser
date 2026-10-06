#!/usr/bin/env node
/**
 * MCP server giving an agent allowlisted Linear actions without a Linear token.
 *
 * Started by Claude Code from an mcp config, once per run. It reads the relay
 * address and the agent's pull token from the same env file the bridge uses; the
 * agent only ever sees tool names. See linear-tools.mjs and the relay's
 * linear-api.mjs for what each tool can do.
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { TOOLS, callTool } from './linear-tools.mjs';
import { parseEnv } from './slack-tools.mjs';

const ENV_PATH = process.env.AGENT_ENV_PATH || join(homedir(), '.config', 'agentic-browser', 'env');
const env = parseEnv(await readFile(ENV_PATH, 'utf8'));
if (!env.LINEAR_RELAY_URL || !env.LINEAR_RELAY_TOKEN || !env.LINEAR_AGENT) {
  console.error(`linear-mcp: LINEAR_RELAY_URL, LINEAR_RELAY_TOKEN and LINEAR_AGENT must be set in ${ENV_PATH}`);
  process.exit(1);
}
// Set by the bridge on a teammate's turn; empty on the operator's.
// The name is set only on a Slack teammate's turn, from Slack, never by the agent.
const ctx = {
  relayUrl: env.LINEAR_RELAY_URL,
  token: env.LINEAR_RELAY_TOKEN,
  agent: env.LINEAR_AGENT,
  requester: process.env.AGENT_REQUESTER_ID || undefined,
  requesterName: process.env.AGENT_REQUESTER_NAME || undefined,
};

const server = new Server({ name: 'linear', version: '0.1.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (req) => callTool(req.params.name, req.params.arguments || {}, ctx));
await server.connect(new StdioServerTransport());
