#!/usr/bin/env node
/**
 * MCP server exposing Slack to the agent without exposing the token.
 *
 * Started by Claude Code from the bridge's mcp.json, once per run. It reads the
 * bot token from the same env file the bridge uses, and the agent only ever
 * sees tool names. See slack-tools.mjs for why.
 *
 * Bridge-only by design. Routines run unattended and notify-only, so routines.mjs
 * filters this server out of their allowlist rather than hand them a way to
 * post.
 */
import { readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import bolt from '@slack/bolt';
import { TOOLS, callTool, parseEnv } from './slack-tools.mjs';

const ENV_PATH = process.env.AGENT_ENV_PATH || join(homedir(), '.config', 'agentic-browser', 'env');

const env = parseEnv(await readFile(ENV_PATH, 'utf8'));
if (!env.SLACK_BOT_TOKEN) {
  // To stderr, which Claude Code logs and the agent does not read, and without
  // the value: the point of this server is that the token goes nowhere.
  console.error(`slack-mcp: SLACK_BOT_TOKEN is not set in ${ENV_PATH}`);
  process.exit(1);
}

const client = new bolt.webApi.WebClient(env.SLACK_BOT_TOKEN);

// Who the bot is, so its own messages are labelled as the agent's. Failure is
// not fatal: the labels degrade, the tools still work.
let botUserId = null;
try {
  botUserId = (await client.auth.test()).user_id || null;
} catch {
  console.error('slack-mcp: auth.test failed; bot messages will not be labelled');
}

const ctx = {
  client,
  botUserId,
  allowedUser: env.ALLOWED_USER || null,
  // The run's cwd is the workspace. /tmp is listed as well as tmpdir() because
  // on macOS they differ, and screenshots land in both.
  uploadRoots: [process.cwd(), process.env.AGENT_WORKSPACE, tmpdir(), '/tmp'].filter(Boolean),
};

const server = new Server({ name: 'slack', version: '0.1.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (req) =>
  callTool(req.params.name, req.params.arguments || {}, ctx),
);
await server.connect(new StdioServerTransport());
