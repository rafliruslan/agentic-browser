# How it works

The parts, the front doors, and how it keeps itself running. Back to the [README](../README.md).

## Why it exists

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

It is smaller and less capable than either. [How it compares](comparison.md), honestly.

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
