# Lessons

Back to the [README](../README.md).

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
