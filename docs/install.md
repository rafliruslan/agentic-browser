# Install and configure

Everything the [README](../README.md) quick start leaves out.

## Install

```bash
# 1. Browser layer
#    Linux: Brave over CDP
/plugin marketplace add rafliruslan/chief-of-staff
/plugin install agentic-browser
/browser-setup

#    macOS: Aside. Nothing to set up beyond having it installed and signed in;
#    `aside mcp` is the whole integration.
aside --version

# 2. Harness
git clone https://github.com/rafliruslan/chief-of-staff ~/.local/share/agentic-browser
cd ~/.local/share/agentic-browser/bridge && npm install
(cd ../plugin/repl && npm install)                # Linux only: the diff-snapshot server

mkdir -p ~/.config/agentic-browser
cp config.example/env ~/.config/agentic-browser/
chmod 600 ~/.config/agentic-browser/env        # then fill in your tokens

# Pick the browser layer. This file IS the choice of browser.
sed "s|/home/USERNAME|$HOME|" config.example/mcp.json \
  > ~/.config/agentic-browser/mcp.json                                  # Linux, Brave
sed "s|/Users/USERNAME|$HOME|" config.example/mcp.aside.json \
  > ~/.config/agentic-browser/mcp.json                                  # macOS, Aside

# 3. Keep it running (pick your platform)

# Linux
cp systemd/agentic-browser.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now agentic-browser

# macOS
sed "s|/Users/USERNAME|$HOME|g" launchd/com.agentic-browser.bridge.plist \
  > ~/Library/LaunchAgents/com.agentic-browser.bridge.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.agentic-browser.bridge.plist
```

`config.example/mcp.json` repeats what the plugin already registers, and has
to. The bridge runs `claude -p` with `--strict-mcp-config`, which loads only the
file it is handed and ignores everything else configured, so the bridge needs
its own copy of the two server definitions. That flag is deliberate: it is what
stops the agent seeing a tool it will then be denied, which reads to it as "I
need permission" and stops it before it tries the browser.

The agent's `workspace/` ships inside the clone and is used in place. Copy it
somewhere else and set `AGENT_WORKSPACE` only if you want the repo to stay
pristine while the agent writes its own memory.

Optionally give it a character: `cp examples/hammock/persona.md
~/.config/agentic-browser/persona.md` and edit. Without one it falls back to a plain
assistant that still carries the honesty and autonomy rules.

You need a Slack app with Socket Mode on, `app_mention` subscribed, and 12 bot
scopes: `app_mentions:read`, `chat:write`, `users:read`, `channels:read`,
`groups:read`, `mpim:read`, `im:read`, the four `*:history` ones, which
`conversations.replies` needs so it can read a thread it was tagged into late
and find mentions it missed while disconnected, and
`files:read`, without which the `file` tool gets Slack's login page instead of an
attachment.

So that an untagged `!stop` reaches a run, and for following threads under
`AGENT_MENTION_ONLY=0`, also subscribe to the `message.channels`,
`message.groups`, `message.im` and `message.mpim` bot events. These need no new scopes: the four `*:history` ones above already cover
them, so it is a config change rather than a reinstall.

`reactions:write` is optional. With it, the agent marks your own message 👀 when
it picks the work up and ✅ or ❌ when it finishes, which is visible from the
channel list rather than only inside the thread. Without it those calls no-op
and nothing else changes.

### Teammates and other settings

A teammate is a second tier, enforced in code rather than asked for in the
prompt. They are served only in listed channels. Their turns refuse the shell,
free-prompt agents and scheduling, and the path fence refuses credentials and
operator-only pages when the hooks are told a teammate is asking. Each teammate
gets a conversation of their own in a thread, so they never inherit what the
operator asked there earlier. `OPS_USERS` opens a little more to an operations
team, and only where nobody else can read the reply.

All optional, all in `~/.config/agentic-browser/env`; `config.example/env` has
each one with a comment.

| Setting | What it does |
|---|---|
| `TEAM_USERS` | Member ids of teammates, a second tier. Their turns get no shell, no free-prompt browser agent and no scheduling, and the hooks fence off credentials and operator-only pages. Unset: operator only. |
| `TEAM_CHANNELS` | Where teammates are served: channel ids, `*` for every channel the bot is in, `!C...` to leave one out. Under `*` a DM or group DM never counts, and a channel whose kind Slack cannot confirm is refused. Empty: nowhere. |
| `TEAM_DMS` | `1` lets people DM the agent. A top-level DM needs no tag and no thread: the DM is one conversation, answered flat, and the last ten messages go in as context. A teammate is admitted in their own DM only (never a group DM). Needs the `message.im` event and `im:history`, plus the App Home Messages tab with sending allowed. Unset: DMs are ignored, as before. |
| `OPS_USERS` | Teammates in the operations team. They reach the fence's `opsAllow` paths, but only in their own DM with the agent or a private channel whose members are all ops, the operator, the agent or an app on `OPS_BOTS`. Elsewhere they are fenced like any teammate. |
| `OPS_BOTS` | Apps allowed in that private channel, such as Linear. Any other member turns it back into an ordinary channel. |
| `UPLOAD_FENCE` | The path fence JSON the file tools use. Set it and Slack `upload` and WhatsApp attachments obey it too, so a teammate is not sent what their turn may not read. Unset, teammates are sent no files. |
| `MAX_CONCURRENT` | How many runs may be in flight at once across threads. Default 3. |
| `LINEAR_RELAY_URL`, `LINEAR_RELAY_TOKEN`, `LINEAR_AGENT` | All three or none: where the relay is, this bridge's pull token, and the name the relay knows it by. Set up the Worker first; see `linear-relay/README.md`. |
| `UNZIP_SANDBOX` | The `file` tool unpacks a `.zip` beside it and lists the files; nothing in it is run. The default strict profile has lower size caps and skips programs, scripts, installers and hidden files. `0` turns it off. |
| `UPLOAD_BROWSER_SESSIONS` | Absolute path of the browser's sessions folder. `upload` may then send a file the browser saved to a session's `artifacts/` or `tmp/`, judged by its real path. Never on a teammate's turn. |

WhatsApp has its own config, `whatsapp.json` (path in `WA_CONFIG`), naming the
chats to answer and each one's role, and runs from a timer job like the
routines. It starts in dry mode.

Slack has no typing indicator for ordinary bots. The nearest equivalent is
`assistant.threads.setStatus`, which needs the app configured as an AI
assistant and only works inside assistant threads. The bridge calls it anyway
and ignores the refusal, so turning the Agents feature on later lights it up
with no code change.

## One agent, two machines, two browsers

The bridge does not know what a browser is. It runs `claude -p` with an
`--mcp-config`, and whatever servers that file names are the browser. So the
same clone, the same persona, the same memory repo and the same Slack app run on
both machines, and the thing that differs is one JSON file.

| | Linux | macOS |
|---|---|---|
| browser | Brave, driven over CDP | [Aside](https://aside.com) |
| MCP config | `config.example/mcp.json` | `config.example/mcp.aside.json` |
| browser tools | `brave`, `devtools`, `browser-repl` | `aside` |
| service | `bridge/systemd/` | `bridge/launchd/` |
| history db | `~/.local/share/browser-profile/Default/History` | `~/Library/Application Support/Aside/Default/History` |

Nothing else in the bridge or the REPL is written against an OS. Every path is
`homedir()` plus an XDG-shaped suffix, which is a plain directory on macOS too.
`node --test` in `bridge/` passes 672/672, last run on macOS. The WhatsApp
front door is the exception to all this: it drives WhatsApp Web through Aside.

### The allowlist is derived, not written down

`--allowedTools` is a whitelist, and its failure mode is silent: an unlisted
tool is not denied loudly, it is simply never offered. A hardcoded `mcp__browser`
list therefore leaves the agent on the other machine with no browser and no
error to explain it. So `browser.mjs` reads the MCP config and allows
`mcp__<server>` for whatever it finds. `--strict-mcp-config` means that file is
exactly the set of servers that will exist, so the two cannot drift.

Aside's history database is Chromium's, same `urls` and `visits` schema, so the
observer works unchanged with `AGENT_HISTORY_DB` pointed at it.
`BRAVE_HISTORY_DB` still works as an alias.

The same config answers a second question. Only a CDP browser can be
preflighted for wedged targets, and only a CDP browser wedges that way, so
`cdpEndpoint()` reads the endpoint out of `mcp.json` and the health check is
skipped where there is none. It returns the URL rather than a boolean, so the
probe uses the port actually configured instead of assuming 9222. Startup says
which it got:

```
[browser] mcp__aside (from …/mcp.json), not CDP, health preflight off
[browser] mcp__browser, mcp__devtools, mcp__browser-repl (from …/mcp.json), CDP at http://127.0.0.1:9222
```

### Where the macOS setup is less safe, plainly

On Linux the agent gets granular browser tools and the one that runs arbitrary
JavaScript is denied in code, after it escalated to raw JS against a half-open
Google Calendar dialog and left a ghost event behind.

`aside mcp` exposes exactly one tool, `repl`, which executes arbitrary
JavaScript against the live logged-in browser. There is no granular
`click(ref)` to allow instead. Denying it leaves the agent with no browser;
allowing it grants exactly the capability that was removed on Linux. That is
not a setting, it is the shape of the API.

So on macOS the guardrails are the path fence on file tools, the fence around
tool output, the allowed users, and a human reading every reply. It is a real reduction against the Linux
setup, and worth knowing which machine you are talking to.

### Service manager

`bridge/systemd/` and `bridge/launchd/` hold the same jobs under both names. The
plists hardcode paths with `USERNAME` in them, because launchd expands neither
`~` nor `$HOME`, so they are meant to be `sed`-ed once at install.
`ThrottleInterval` stands in for `StartLimitBurst`, guarding the same thing: a
crash loop reconnecting faster than the single-instance lock can settle would
have Slack delivering every mention to two bridges.

launchd has no timer unit, so the dream and routines timers become
`StartInterval` seconds on the job. That drops systemd's `Persistent=true`,
where a timer missed while the machine was asleep fires on wake. On macOS a
`StartInterval` job that comes due while asleep runs once at wake, which is
close enough for a memory pass and worth knowing for anything that must not be
skipped.

An agent that edits its persona or the bridge needs its own bridge restarted,
and cannot do it in the run that asks: the run is a child of the bridge and is
cut off before it replies. `node bridge/restart-self.mjs` schedules a one-shot
job outside the bridge that waits 40 s, then until no run has been in flight
for two checks in a row, restarts the service once and logs old and new pid to
`restart-self.log` in the state directory. It finds the service from
`XPC_SERVICE_NAME` or, since the agent's shell drops that, the first parent
process that `launchctl list` names (launchd), or from the cgroup (systemd);
`--service <label>` names another bridge. It exists because the
improvised version, `launchctl submit` with `sleep; kickstart`, loops: a
submitted job is KeepAlive, so it restarted the bridge every 30 seconds for
hours, twice.

`/browser-setup` also documents running Brave on macOS, for anyone who wants that
instead of Aside. The Chromium 136+ refusal to open a debug port at the default
profile path applies on both platforms.

## Git hooks

Hooks are not installed by a clone. Run this once per checkout:

```sh
git config core.hooksPath .githooks
```
