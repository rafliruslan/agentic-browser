# This machine, and what replaced what

Written 2026-08-25, the day the agent moved off the Mac.

## Machine

- **Omarchy Linux** (Arch, Hyprland), hostname `omarchy`. Not macOS.
- **The architecture is `aarch64`, not x86_64.** Anything you download or
  install needs the ARM64 build. Brave's user-agent claims `Linux x86_64`, but
  Chromium freezes that string, so it is not evidence. Check `uname -m`.
- Harness is **Claude Code**, run headless by a Slack bridge at
  `~/bin/aside-slack/`. It runs on the user's Claude subscription, not API billing.
- Your working directory is `~/.local/share/agent/workspace`. File access is
  scoped to it. A write outside it is refused, and the refusal is reported
  honestly rather than hanging.
- One Slack thread maps to one Claude Code session, so a thread remembers
  itself. Across threads, only what is written into `memory/` survives.

## Browser

- **Brave**, running the user's real profile at `~/.local/share/browser-profile`,
  attached over CDP on `127.0.0.1:9222`.
- **Two servers, one browser.** `mcp__browser__*` is Playwright MCP and
  `mcp__devtools__*` is chrome-devtools-mcp; both attach to the same CDP
  endpoint and see the same tabs.
  - **Read with brave.** `browser_snapshot` gives an accessibility tree with
    `[ref=eNN]` ids, and `browser_find` searches it cheaply. Screenshot only
    when the task genuinely depends on pixels.
  - **Click with devtools when Playwright refuses.** `browser_click` can fail
    with `waiting for element to be visible, enabled and stable` on pages that
    animate continuously; Google Calendar is one. That is Playwright's
    actionability gate, not a bad ref, and retrying never fixes it.
    `mcp__devtools__click` has no such gate.
  - The two use **different identifiers**: brave gives `[ref=e123]`, devtools
    gives `uid=1_21`. They are not interchangeable, so snapshot with the server
    you are about to act with.
- devtools also exposes network requests, console messages and performance
  traces, which brave does not. Useful when a page is misbehaving rather than
  merely needing to be driven.
- The profile is **already logged in** to Slack, Google Workspace, Linear and
  Shopify. Nothing needs OAuth.
- **Always the Work profile.** Inside `~/.local/share/browser-profile` the
  profiles are directories, not display names: `Default` is **Work**,
  `Profile 3` is **Personal**. Brave is pinned to `Default` by
  `--profile-directory` in `~/.config/brave-flags.conf`, and CDP tabs land
  there. Verified 2026-08-25: `brave://version` reported Profile Path
  `/home/<you>/.local/share/browser-profile/Default`.
- **Never work in Personal.** If you find yourself on a page signed in as his
  personal account rather than the the company one, stop and say so rather than acting.
  `brave://version` confirms which profile you are in.
- If CDP is unreachable, Brave is simply not running. Say so; do not improvise
  another browser.

## You are not alone in this browser

the user uses it, and Claude Code in his terminal attaches to the **same** CDP
endpoint. All three of you share one set of tabs. Two consequences, both
observed on 2026-08-25:

- **A ref can go stale because someone else moved**, not because the page
  re-rendered on its own. `Ref eNNN not found` mid-task can mean another agent
  is working the same page. Re-snapshot and look at what actually changed
  before assuming your own step failed.
- **A dialog you did not open may be someone else's work in progress.** On
  2026-08-25 Claude Code found a filled-in Google Calendar out-of-office dialog
  and came within one click of saving it; it was the agent's, mid-task. Never
  submit a form you did not fill in yourself. Close nothing you did not open.

If you find the page in a state you did not create, say so and ask rather than
tidying it up.

## What no longer exists

Aside was retired for this user on 2026-08-25. Older memory describes its API.
None of it is callable:

| Gone | Now |
|---|---|
| `repl` tool, persistent JS scope | Individual `mcp__browser` tool calls |
| `snapshot(page)` | `browser_snapshot` |
| `openTab()`, `attachBrowserTab()` | `browser_navigate`, `browser_tabs` |
| `page.locator('e77').click()` | `browser_click` with a `ref` |
| `slack` global, `slack.getClient()` | Drive Slack in the browser, or its web API directly |
| `aside` global, `fork_self`, `cua` | No equivalent |
| Aside bash sandbox quirks | Ordinary Linux, ordinary `Bash` tool |

Techniques recorded against those globals are still **conceptually** right. The
Slack composer quirks in `memory/sites/app.slack.com.md` in particular are
properties of Slack's DOM, so they survive the move even though the calling
syntax changed.
