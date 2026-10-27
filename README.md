# agentic-browser

Tag it in Slack, mention it in Linear, or message a WhatsApp chat it watches,
and it works in the browser you are already signed in to. Runs on Linux and
macOS, billed to a Claude subscription rather than per token.

Built because [Aside](https://aside.com) is macOS-only and
[Hermes Agent](https://github.com/NousResearch/hermes-agent) runs anywhere but
has no first-class browser, and its Claude path needs a Max plan with purchased
extra credits. This is Claude Code, your real browser, and a bridge in between:
about 9,700 lines, with 6,800 lines of tests over the parts that can be tested
without a browser. It began at 2,700. Most of the growth is guardrails, added
once teammates could use it too.

On Linux that browser is Brave over CDP, which was the whole reason this exists.
On macOS it is Aside, driven through its MCP server, because Aside is the better
browser when you can have it. The bridge does not know the difference: which
browser is attached is one JSON file. That is what keeps it one agent to
maintain instead of two.

It is smaller and less capable than either. [How it compares](#how-it-compares),
honestly, below.

```
Slack (Socket Mode) ──────────┐
Linear → relay (a Worker) ────┼─→ bridge (systemd / launchd)
WhatsApp Web, on a timer ─────┘     └─→ claude -p        ← your Claude subscription, not API billing
                                          └─→ browser MCP   (Aside, or Playwright + chrome-devtools-mcp)
                                                └─→ your real browser, already logged in
```

## The parts, usable separately

| | |
|---|---|
| **`plugin/`** | A Claude Code plugin: four MCP servers on one running Brave, plus the browser skills and `/browser-setup`. Useful on its own if you just want Claude Code to drive your browser from a terminal. The two servers written here live under it, because a plugin can only reach files inside its own root. |
| **`bridge/`** | The harness. Front doors for Slack, Linear and WhatsApp that map conversations to sessions, serialise work per thread, survive restarts, and recover their own orphaned messages. Also the scheduled routines, and tool servers that hold the Slack and git tokens so the agent never does. |
| **`workspace/`** | The agent's memory and skills, as a starting template. Semantic memory it reads on demand, procedural skills it can extend itself. |
| **`plugin/repl/`** | A third MCP server of our own: accessibility snapshots that return a **diff**, and `fetch`, which calls a site's own API from inside a tab already signed in to it. See `plugin/repl/README.md`. |
| **`plugin/memory/`** | A fourth: ranked search over `workspace/memory/` that returns matching **sections** rather than files. |
| **`linear-relay/`** | A Cloudflare Worker that takes Linear's webhooks, checks the signature and author, and queues them for a bridge to pull. The only public piece: nothing on the machine listens. See `linear-relay/README.md`. |
| **`sync/`** | Keeps each agent's memory folder in a git repo across machines: commit, merge and push every few minutes. A conflict, or anything that looks like a secret, stops that one store with the reason on disk. |

## It learns while you use it

`bridge/dream.mjs` runs nightly and consolidates two things into the memory tree:
recent conversations with tool calls stripped, and a digest of how you actually
used the browser when nobody asked you anything.

The browsing half matters more than it sounds. Sites you return to daily are the
tools you live in; a site that never appears in a conversation is a project the
agent does not know exists. On the first real run it connected three unrelated
domains and wrote *"something token-adjacent is being scoped"* about work it had
never been told about.

`bridge/observe.mjs` produces that digest and is deliberately **aggregate**:
domains, counts, busiest hours, recurring page titles. Never a URL log. Whatever
it writes ends up in a file an agent reads while also reading arbitrary web
pages, so a browsing history sitting in that context is an exfiltration target.
Domain counts are not. A log is also not a pattern: "177 visits to Slack,
concentrated 09:00-11:00" is worth keeping, 847 timestamped URLs is not.

Lines where you corrected or contradicted the agent are flagged `[PUSHBACK]`,
because a correction is you stating a preference at the one moment you cared
enough to interrupt. It is told to turn those into rules.

Two things this taught us, both now in the code:

- **It must not read its own transcripts.** Dream runs in the same workspace, so
  its output lands where the next run looks. Left alone it consolidates its own
  reflections, and its own "do NOT write" instructions match the correction
  regex and get flagged as you pushing back.
- **It fixes its own bugs.** One run noticed that six sessions had each burned a
  turn on the same permission denial, traced it to a wrong path in its own
  `skill-creator` skill, corrected it, and recorded the exact error text so a
  future session recognises it.

**What it costs.** Runs report a `total_cost_usd`: $1.60 for the first twelve
sessions, then $0.90, then $0.70 as more of it was already recorded. On a Claude
subscription that figure is **notional**: it is what those tokens would have
cost at API list price, not a charge. What the run actually consumes is your
plan's usage allowance, roughly one substantial Opus conversation per night,
spent whether or not the day taught it anything. With an `ANTHROPIC_API_KEY` set
it is a real charge.

The falling curve is the thing to watch either way: a well-fed memory makes each
pass cheaper, because most of what it reads is already recorded and it says so
rather than rewriting it.

Disable with `systemctl --user disable --now agentic-browser-dream.timer`.

## Why it works on real sites

**It uses your browser, not a clean one.** Slack, Gmail, Linear, Shopify sessions
already exist. Nothing does OAuth, no credentials are handled. Anything it does
is done as you.

**It reads trees, not pixels.** `browser_snapshot` returns an accessibility tree
with stable refs: a few KB against a screenshot's hundreds, no vision needed,
and refs survive re-renders far better than CSS selectors. Screenshots are for
questions genuinely about pixels.

**Two browser servers, on purpose.** Playwright's click requires the element's
bounding box to be unchanged across two consecutive animation frames. Pages that
animate continuously never satisfy it, and the error reads like a bad ref when
the ref is fine. chrome-devtools-mcp dispatches over CDP without that gate.
Measured on Google Calendar: Playwright failed three times on one button,
devtools clicked first try.

**Formatting is code, not instruction.** Slack renders `**bold**` as literal
asterisks, has no list syntax at all, cannot render a Markdown image tag, and
needs `&<>` escaped in one field and literal in another. Every one of those was
first written into the prompt, and the agent still got them wrong often enough to
matter. They are now deterministic functions applied to every message on the way
out, which is also what let the persona shrink by 82%.

## It answers when tagged

A mention starts a turn; an untagged reply does not. Talking in a thread the
agent is in should not mean talking *to* it. It still reads the whole thread
when tagged, so whatever was said while it was quiet is in front of it.

`AGENT_MENTION_ONLY=0` restores the older mode: after replying it follows the
thread for a day, and a plain reply from the allowed user reaches it with no
@mention. Following is narrow on purpose, because subscribing to `message.*`
means receiving every message in every channel the bot is in, and
`shouldHandle` drops almost all of it before any work happens. A mention
arrives twice, once as `app_mention` and once as `message`; the message path
ignores anything containing the bot's id, so the task runs once. Saying `stop`,
`quiet` or `stand down` in the thread ends following and the agent waves.

**Cutting in.** A reply in a busy thread waits behind the run, which is right
for a follow-up and useless for "no, not that". A message that starts with `!`
interrupts instead, with no tag needed: `!stop` ends the run, and `!` followed
by anything else ends it and starts the next turn with that as the instruction.
The conversation survives, because the session comes from the thread; only the
step in flight is lost. A teammate may stop or steer only a run they started.

**Choosing the model.** Sonnet takes the ordinary turn and Opus takes work that
is visual or deep, picked by a word list rather than a classifier, because being
wrong costs one pricier run and a classifier would cost a round trip on every
message. Open with `deep:` or `fast:` to choose yourself.

## Linear, WhatsApp and routines

**Linear.** Mention the agent in an issue, or assign it one, and
`linear-relay/` queues the event; the bridge pulls it. The relay has already
checked the signature and that the author is the operator. The issue's own text
is everyone's words, so it reaches the agent fenced as data. An event is handed
over once and deleted first: a crashed bridge loses it rather than replaying an
action in a logged-in browser.

**WhatsApp.** A number linked to a browser has no socket, so `whatsapp.mjs`
wakes every minute, reads the chat list in WhatsApp Web, and answers the few
chats named in its config. Four rules, each against a real failure:

- **Allowlist only.** A chat not in the config is never opened, read or marked
  read. The default `mode: "dry"` opens nothing and logs what it would do.
- **The bridge sends, not the agent.** The agent returns text; the bridge checks
  the chat header, types it, sends, and reads the bubble back. A prompt cannot
  make it message another chat.
- **A human who answered first wins.** Only messages after the account's own
  last message count, so a reply from the phone ends the matter.
- **No role escalation.** A chat's role comes from the config. A sender's name
  is trusted only when the page proves it: a saved contact, the sender's own
  number, or an id pinned in the config.

Photos and documents sent with a request (PDF, text, CSV, Word, Excel,
PowerPoint; up to four, 30 MB each) are saved to a private folder and handed
over by path, with the text of Office files extracted. In a group only the files
that came with the request count, not whatever else is in the chat. A message
that arrives while a run is going is answered when the run ends, instead of
being buried under the reply.

**Routines.** `routines.mjs` runs scheduled work described in
`memory/routines/*.md`, and the file is both the instruction and the memory: a
run that learns something writes it back where the next run reads. Routines
report unless one opts in to acting, keep one log line per run, and a run
missed while the machine slept is skipped rather than fired late. A payout
reminder at midnight because the laptop woke up is worse than none.

## Only one bridge at a time

Slack Socket Mode allows several concurrent connections and delivers
`app_mention` to every one of them. Two bridges therefore answer every mention
twice, with two agents reaching two different results in the same thread.
Nothing errors. The agent simply looks like it contradicts itself.

The bridge takes a lock at `~/.local/state/agentic-browser/bridge.lock` and refuses
to start if a live process holds it, naming the pid and host so you know what
to stop. A lock left by a crash is taken over automatically, so this never
wedges a restart.

That covers one machine. It cannot see a bridge running elsewhere on the same
Slack app, so if you move the agent to another box, stop the old one first.

## It notices when it has gone deaf

Each of these was found the same way: someone asked why the agent had stopped
answering.

- **The socket dies quietly.** Socket Mode reconnects on its own, but some
  errors end its retries and a reconnect that never completes logs nothing.
  `socket-watch.mjs` follows the client's own events and exits after three
  minutes down, so the service manager starts a fresh bridge. A run in flight
  gets ten more minutes first, since it replies over HTTP.
- **Mentions sent while it is deaf are gone.** Slack delivers an event to
  whatever socket is open, retries for a few minutes, then gives up, so a
  laptop with its lid shut misses whatever was sent meanwhile. After every
  reconnect, and once at startup, `catchup.mjs` reads recent channel and thread
  history for mentions with no reaction or reply from the bot, and answers them
  with a note that they arrived late. One already seen live is skipped, so a
  late retry from Slack is not answered twice, and a late `!stop` is never
  replayed into whatever is running now.
- **An upgrade deletes the binary it runs on.** `binary-watch.mjs` exits when
  the node it started on disappears, and the service manager restarts it on the
  new one. Homebrew can also replace a library that a pinned node links
  against: the running bridge carries on, and every new node process it starts,
  tool servers included, dies on launch. `node -v` after an upgrade tells you.

## Git hooks

Hooks are not installed by a clone. Run this once per checkout:

```sh
git config core.hooksPath .githooks
```

## How it compares

Written by someone who ported from Aside and read Hermes' docs, not by a
benchmark. Take the "worse" rows seriously.

Aside is in two columns of this table at once, which is not a mistake. It is the
thing this was built to replace on Linux, and it is the browser this drives on
macOS. Comparing against a product you also depend on is awkward to write and
honest to read: the rows below are about Aside as a whole agent, not about the
browser, which is very good and is why it is the macOS layer.

| | **agentic-browser** | **Aside** | **Hermes Agent** |
|---|---|---|---|
| Platform | Linux, macOS | **macOS only** | anywhere |
| Browser layer | Brave (Linux), Aside (macOS) | its own | not a focus |
| Licence | MIT | commercial | open source |
| Browser | first-class, real profile | **first-class, real profile** | not a focus |
| Billing on Claude | **subscription** (`claude -p`) | subscription | Max + purchased extra credits, or per-token API |
| Channels | Slack, Linear, WhatsApp (polled) | Slack, Telegram, Discord | **Slack, Telegram, Discord, WhatsApp, Signal, CLI** |
| Memory | markdown files, ranked section search | local-first, structured | **FTS5 + LLM summarisation** |
| Skills | markdown, self-extending, site notes injected on arrival | markdown, keyword auto-inject | markdown, self-improving |
| Execution backends | local | local | **6, incl. Docker, SSH, Modal** |
| Users | an operator plus teammates, two tiers | many | many |

### Where Aside is better

It tops the browser-agent benchmarks (Online-Mind2Web, BU-Bench-V1 and
Odysseys), and this is used by one small team. It shields credentials from the
model at the vault layer. Here the Slack and git tokens sit in tool servers the
agent cannot read, but anything visible in the browser is visible to it. Its single `repl` tool is more expressive than granular
MCP calls: one 120-second call can snapshot, decide, act and verify where this
takes a dozen round-trips. The `fetch` tool closes part of that: where a site
has an API, this now reaches it in one call with the session attached, the same
way Aside's site skills avoid opening a tab. Where it does not, the round-trip
gap stands. That last point stopped being a comparison and became
a dependency: on macOS this drives Aside, so it gets the expressive `repl` and
also loses the ability to deny it. See
[where the macOS setup is less safe](#where-the-macos-setup-is-less-safe-plainly).

### Where Aside is worse

It does not run on Linux, which is the entire reason this exists. And its own
internals note that its permission mode was "largely cosmetic", because an
ungated `bash` tool let the agent shell around the file restrictions. Granular
gated tools are less expressive but mean a dangerous capability can actually be
removed: `browser_run_code_unsafe` was denied here after it left a half-created
calendar event behind, and nothing else broke.

### Where Hermes is better

Six messaging channels through one gateway against three here, one of them a
browser tab read once a minute. Six execution backends against local-only. And
real memory *retrieval*, full-text search with LLM summarisation, where this
ranks sections of a markdown folder by keyword.

### Where Hermes is worse

Its `claude-code` OAuth provider requires a Max plan **with purchased extra
credits**; the base allowance is never consumed and Pro cannot use it at all.
The fallback is an API key at per-token pricing. `claude -p` bills a normal
subscription. If that constraint is what brought you here, Hermes does not
satisfy it.

It also has no equivalent browser layer. Driving sites you are already logged in
to is the whole premise here, not an integration.

### What this is honestly good for

Being small enough to read end to end and change, with the reasoning for each
non-obvious decision written next to it. If you want a product, use Aside on a
Mac. If you want breadth, use Hermes. If you want your own real browser driven
from Slack on a subscription you already pay for, and the same setup to survive
switching OS, this is the shape of it.

## Install

```bash
# 1. Browser layer
#    Linux: Brave over CDP
/plugin marketplace add rafliruslan/agentic-browser
/plugin install agentic-browser
/browser-setup

#    macOS: Aside. Nothing to set up beyond having it installed and signed in;
#    `aside mcp` is the whole integration.
aside --version

# 2. Harness
git clone https://github.com/rafliruslan/agentic-browser ~/.local/share/agentic-browser
cd ~/.local/share/agentic-browser/bridge && npm install
(cd ../repl && npm install)                # Linux only: the diff-snapshot server

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

## Things that took a day each

Collected here so they cost you an afternoon instead.

**Spawn the agent with stdin closed.** Node's `spawn` defaults to a piped stdin
that never reaches EOF, and the CLI blocks on it forever rather than exiting.
Measured: hung past 35s versus 779ms with `stdio: ['ignore','pipe','pipe']`. No
mocked-spawn unit test catches this.

**Record the run before it starts, clear it after.** Whatever says "working"
has to be unsaid by the same process, and that process can die. The bridge used
to post a "running…" message and edit the answer into it; after 29 restarts one
from 12:38 still said "running…" at 21:41.

The progress signal is now a 👀 reaction plus the assistant status line, neither
of which leaves a message behind, and the answer is posted rather than edited
in. That removes the litter but not the leak: a dead process still leaves a
reaction and a status that say a run is in flight. So the record outlives the
placeholder it was built for, and startup clears both and says what happened.

**Sessions expire underneath you.** Detect it, drop the mapping, silently retry
in a fresh session. Never show the user an error for this.

**Slack is the durable store; the session is a cache.** Do not treat one thread
as one infinite session. Map thread to session, let it expire, then reconstruct
context from the Slack transcript. That property is what let this survive its
sessions being evicted.

**A tool that is visible but denied is worse than one that does not exist.** The
agent will pick the API connector it can see, be refused, and report a permission
problem, while the site sits logged in one tab away. Use `--strict-mcp-config`
so it only sees what it can actually use.

**A config-driven default that works is the hardest kind to notice.** Moving the
persona from hardcoded to a config file turned a value into a missing file, and
the fallback was competent enough that the agent ran without its character for
sixteen hours before anyone spotted it. If a fallback is good, log when you take
it.

**Screenshots stay in the conversation.** Each one is re-sent on every later
turn, so five of them cost far more than five screenshots. One run took five full
page PNGs, two at 1.1MB, and passed a ten minute timeout with nothing reported.
The shipped `mcp.json` caps devtools screenshots at jpeg quality 60 and 1400px
for that reason.

**Verify, do not report.** Many web apps render an unsaved item exactly like a
saved one. Google Calendar labels an unsaved event `Event is being created.`
"The click returned success" is not evidence the app accepted it.

**One wedged tab takes down every browser server at once.** Playwright and
Puppeteer both connect by enabling `Runtime` and `Network` on *every* target and
waiting for all of them, so a single target that stops answering CDP times out
every browser call all three servers make. The browser looks perfectly healthy
from outside: `/json/version` answers in 8ms and every tab renders. Measured 735
commands on connect, 712 answered, 23 unanswered, all from one stuck Google
Calendar tab and three of WhatsApp Web's WASM VoIP workers. Clearing those two
took `connectOverCDP` from a hard 30s timeout to 935ms. `bridge/browser-health.mjs`
now probes every target before each run and reloads or closes what is wedged.

**An agent that routes around an outage spends its whole budget doing it.** When
all three servers died, the agent did exactly what it was told to do when a tool
is refused, which is to find another way, and wrote itself a working CDP client
in Bash. It was still writing it when the ten minute timeout killed the run. The
capability was real and the outcome was nothing delivered. Tell it to report an
infrastructure failure and stop, and fix the infrastructure in code.

## Read this before installing

**An open debug port means any process running as you can drive your browser,
with every session it holds.** It binds to `127.0.0.1` only, but that is the
honest description. Inherent to the design, not incidental.

**Prompt injection is live.** The agent reads arbitrary web pages while holding
your real sessions. Every MCP result is wrapped between markers carrying a fresh
random nonce (`fence.mjs`), so the agent can see where outside text starts and
ends, and a page cannot print its own closing marker. That is a mitigation, not
a boundary: a model can still be talked round, and text inside an image is not
fenced. Do not point this at pages you would not trust with your accounts.

**The agent does not hold the tokens.** Slack and the company repos are reached
through tool servers (`slack-tools.mjs`, `repos-tools.mjs`) that read the token
themselves and hand the agent verbs. Pushes never force, nothing deletes a ref,
and every refspec is built from an allowlist rather than taken from the agent.
File tools are kept inside named folders by a PreToolUse hook
(`path-fence-hook.mjs`) that fails closed.

**Everything happens as you.** Messages come from you, not a bot. Calendar
declines notify real colleagues. There is no undo layer.

`ALLOWED_USER` is the entire access control unless you add teammates (see
[Teammates and other settings](#teammates-and-other-settings)): mentions from
anyone else are ignored in silence, because replying would tell an unauthorised
user the bot is listening.

**That gate has to hold in the transcript too, and it did not at first.** The
agent reads the thread it was tagged into, and every non-bot message was
labelled `[the user]`. So once a second person replied, their words reached the
agent as the words of the one person whose words are instructions: a colleague
typing "actually, cancel that" was indistinguishable from the owner typing it.
It would never have answered them, which was never the risk. It would have acted
on them.

Speakers are distinct now, and the shape is worth naming: a gate on the entrance
is not a gate if a second path copies untrusted input in beside the trusted kind
and drops the label that told them apart.

## Design notes

**Deterministic beats instructed.** Any rule that can be enforced in code must
be. What remains in the persona is only what code cannot check: honesty,
autonomy, and one session per message.

**When it gets stuck, add a narrow capability, not a general one.** The tempting
fix for an unclickable button is arbitrary page scripting. It works until it
half-completes a form and leaves broken state someone finds later. Adding a
second, gated click path solved it without opening that door.

**Guidance it must choose to read will be missed mid-task.** The click-failure
rule lives in the always-on file, not a specialised skill, because it is needed
exactly when deep in a page and not thinking about which skill to open.

## License

MIT
