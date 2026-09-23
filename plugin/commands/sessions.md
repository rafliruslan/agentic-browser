---
description: List past agent sessions and get the command to resume one
---

List what the agent has worked on, newest first, and how to reopen any of it.

Slack threads have been the only view onto past runs, and a thread scrolls
away. The sessions themselves are Claude Code transcripts, so they are all
still here and every one is replayable.

## Run it

```bash
node "${CLAUDE_PLUGIN_ROOT}/../bridge/sessions-cli.mjs" -n 20
```

If the plugin is installed rather than run from a clone, `bridge/` is not
beside it. Use the checkout instead, at wherever you cloned it - the README
installs to `~/.local/share/agentic-browser`:

```bash
node ~/.local/share/agentic-browser/bridge/sessions-cli.mjs -n 20
```

Two environment variables shape the output, both optional:

| | |
|---|---|
| `AGENT_WORKSPACE` | which workspace's sessions to list. Defaults to `~/.local/share/agentic-browser/workspace`; the bridge sets its own, so pass the same value the launchd plist or systemd unit uses. |
| `SLACK_WORKSPACE` | your Slack subdomain, so the permalinks are clickable. Without it they still open from a signed-in Slack. |

`--json` prints the same rows as structured data, for piping.

## Reading it

Each row is one session: how long ago it last ran, how many assistant turns it
took, the first eight characters of its id, and what was asked. A thread with
existing history reduces to the last thing the user themselves said, since the
rest is other people talking.

## Resuming

```bash
cd "$AGENT_WORKSPACE" && claude --resume <id>
```

Say this plainly when reporting back, because it is the one surprising part:
that replays the same conversation **as the person running it**, with their own
MCP config and permissions. It is not the bridge's tool allowlist and not its
`acceptEdits` mode. Same history, different authority.

## When it finds nothing

The error names the directory it looked in and the `AGENT_WORKSPACE` it derived
it from. Almost always that variable is unset or points somewhere else, rather
than the sessions being gone.
