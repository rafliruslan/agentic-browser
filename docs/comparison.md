# How it compares

Against Aside and Hermes Agent. Back to the [README](../README.md).


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
[where the macOS setup is less safe](install.md#where-the-macos-setup-is-less-safe-plainly).

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
