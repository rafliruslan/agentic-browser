# chief-of-staff

A chief of staff for your team. It takes requests in Slack, WhatsApp and
Linear, does the work in the accounts you are already signed into, and
remembers what it learns.

- **Where you talk to it:** tag it in a Slack thread, message a WhatsApp chat it
  watches, or mention it in a Linear issue.
- **Where it works:** your real browser, already logged in to your email,
  drive, store admin, CRM and the rest. Nothing to connect, no API keys per app.
- **What it keeps:** a memory of how your company works, notes on each site it
  uses, and routines it runs on a schedule.

It runs on your own machine, billed to a Claude subscription rather than per
token.

## A day with it

> **In WhatsApp, a supplier group:** "Any update on the certificate?"
> It reads the group, sees the supplier promised it Friday, and answers with the
> date and what is still missing.

> **In Slack:** "@chief the pricing page still says 10%, make it 15%."
> It edits the site, opens a pull request for you to merge, and posts the link.

> **Every morning at 9:** a short list in your DMs of what needs you today:
> unanswered customer emails, payouts due, a teammate waiting on a decision.

> **In a Slack thread about a bug:** "@chief file this."
> It writes the Linear ticket from the thread, credits whoever asked, and links it.

> **A teammate, in their own channel:** "Where's the signed contract with the distributor?"
> It finds it in the shared drive and sends it, if their access allows.

## How it works

```
Slack ───────────┐
WhatsApp Web ────┼─→ bridge on your machine ─→ Claude Code ─→ your real browser, logged in
Linear (relay) ──┘
```

Each request becomes a Claude Code session tied to its thread, so a follow-up
continues the same conversation. The bridge posts the answer back where it was
asked. More in [how it works](docs/how-it-works.md).

## Why you can trust it with your accounts

- **It answers only when tagged.** Talking in a thread it is in is not talking
  to it.
- **Teammates get less than you.** They are served only in channels you list,
  their turns cannot run a shell or schedule work, and file fences keep
  credentials and your private pages out of reach.
- **It never holds your tokens.** Slack and git are reached through tools that
  keep the token to themselves. Your passwords stay in the browser.
- **You can stop it.** Reply `!stop` in the thread and the job ends.
- **WhatsApp is allowlist only.** It opens only the chats you name, and a human
  who answers first always wins.

It still acts as you, in real accounts, with no undo. Read
[security](docs/security.md) before you set it up.

## Quick start

You need a Mac with [Aside](https://aside.com) or a Linux machine with Brave,
[Claude Code](https://claude.com/claude-code) signed in, Node, and a Slack app
with Socket Mode on.

```bash
git clone https://github.com/rafliruslan/chief-of-staff ~/.local/share/agentic-browser
cd ~/.local/share/agentic-browser/bridge && npm install

mkdir -p ~/.config/agentic-browser
cp config.example/env ~/.config/agentic-browser/ && chmod 600 ~/.config/agentic-browser/env
# fill in SLACK_BOT_TOKEN, SLACK_APP_TOKEN and ALLOWED_USER (your Slack member id)

sed "s|/Users/USERNAME|$HOME|" config.example/mcp.aside.json > ~/.config/agentic-browser/mcp.json   # macOS; Linux: docs/install.md
node index.mjs
```

Tag it in a channel it has been invited to. When it answers, set it up to run
on its own with launchd or systemd, and add WhatsApp, Linear, teammates and a
persona: see [install and configure](docs/install.md), which also lists the
Slack scopes.

## Settings

In `~/.config/agentic-browser/env`. The essentials:

| Setting | What it does |
|---|---|
| `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` | The Slack app it answers as. |
| `ALLOWED_USER` | You. Mentions from anyone else are ignored unless you add teammates. |
| `TEAM_USERS`, `TEAM_CHANNELS` | Teammates, and the channels where they are served. |
| `OPS_USERS` | Teammates in operations, who may see a little more, only in private. |
| `LINEAR_RELAY_URL`, `LINEAR_RELAY_TOKEN`, `LINEAR_AGENT` | Linear, through the relay in `linear-relay/`. |

The rest are in [install and configure](docs/install.md#teammates-and-other-settings).

## Further reading

- [How it works](docs/how-it-works.md): the parts, the front doors, routines,
  memory, and how it recovers from a dropped connection or a restart.
- [Install and configure](docs/install.md): every step, both platforms, all
  settings.
- [Security](docs/security.md): what can go wrong, plainly.
- [How it compares](docs/comparison.md): against Aside and Hermes Agent.
- [Lessons](docs/lessons.md): things that each took a day to learn.

## License

MIT
