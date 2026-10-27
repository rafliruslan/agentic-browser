# Security

Read this before giving it your accounts. Back to the [README](../README.md).

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
[Teammates and other settings](install.md#teammates-and-other-settings)): mentions from
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

On macOS the browser tool runs arbitrary JavaScript and cannot be narrowed. See
[where the macOS setup is less safe](install.md#where-the-macos-setup-is-less-safe-plainly).
