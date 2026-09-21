# Rename: brave-agent → agentic-browser

The code stopped being Brave-specific in `ccbe7da`. The name has not caught up.
This is the plan for doing that, written before doing any of it, because most
of the cost is not in the repo.

## The one rule that matters

**Not every "brave" is the project.** 31 of the 322 occurrences are the Brave
*browser*, which is still a supported target and must survive untouched:

| Token | Count | What it is |
|---|---|---|
| `BraveSoftware`, `Brave-Browser` | 20 | Brave's real profile paths |
| `brave-flags`, `brave-browser` | 7 | Brave's real launcher and binary |
| `Brave Browser`, `/Applications/Brave` | 4 | Brave's real macOS bundle |

A blind `sed s/brave/agentic/` corrupts every one of them, and the damage is
quiet: the setup command would tell a Brave user to look in a directory that
has never existed. **Rename by token, never by substring.**

## What changes

| From | To | Count |
|---|---|---|
| `brave-agent` | `agentic-browser` | 85 |
| `mcp__brave` | `mcp__browser` | 40 |
| `brave-repl` | `browser-repl` | 19 |
| `com.brave-agent` | `com.agentic-browser` | 15 |
| `brave-profile` | `browser-profile` | 13 |
| `brave-setup` | `browser-setup` | 5 |

`BRAVE_CDP_ENDPOINT`, `BRAVE_CDP_URL`, `BRAVE_CDP_TIMEOUT_MS` and
`BRAVE_HISTORY_DB` are already aliases for `AGENT_*` names and keep working.
Leave them: they cost one line each and are the only thing keeping an
already-configured machine running.

## Order of operations

The repo is the easy part and comes last but one. Do the stateful things first,
while the old names still work, so nothing is ever half-migrated.

1. **Nothing is running.** `launchctl bootout` all three agents (or `systemctl
   --user stop` on Linux). A plist rename with the job loaded leaves a ghost.
2. **Move the state directories**, keeping the contents:
   - `~/.config/brave-agent/` → `~/.config/agentic-browser/` (env, mcp.json, persona.md)
   - `~/.local/state/brave-agent/` → `~/.local/state/agentic-browser/` (lock, pending.json, subscriptions.json, threads.json)
   - `~/.local/share/brave-profile/` → leave it. It is a browser profile, not
     project state, and moving it invalidates every logged-in session in it.
     Rename it only with the browser shut and nothing else to do that day.
3. **Rewrite the three launchd plists** under new labels, repointing
   `AGENT_MCP_CONFIG`, `AGENT_ENV_PATH`, log paths and `WorkingDirectory`.
   Bootstrap the new labels, then delete the old files. Log paths change:
   `~/Library/Logs/brave-agent.{stdout,stderr}.log` and
   `brave-agent-routines.log`.
4. **The repo and the tokens** - `scripts/rename.sh` below.
5. **GitHub**: rename `rafliruslan/brave-agent` → `rafliruslan/agentic-browser`.
   GitHub redirects the old URL, so existing clones keep fetching, but the
   marketplace entry and the README clone line should both be updated rather
   than relying on the redirect.
6. **Re-install the plugin.** `/plugin marketplace add rafliruslan/agentic-browser`.
   The old plugin must be removed first or both register and the tool names
   collide.
7. **The workspace**, which is a different repo: `hammock-memory` has skills
   naming `mcp__brave__*`. They break the moment the server key changes, and
   they are what `visual-fallback` and `google-calendar` depend on.

## The part that is not mechanical

Renaming the MCP server key `brave` → `browser` changes every tool name the
agent sees. Three consequences:

- **The denylist already follows the config** as of `ccbe7da`, so arbitrary
  script stays blocked under the new name without anything being edited. This
  was the one real hazard and it is already handled.
- **Two workspace skills** reference `mcp__brave__*` by name and must be edited
  in the same change, or the agent is told to call tools that no longer exist.
- **Session transcripts already written** name the old tools. They are history
  and stay as they are; nothing reads them for tool names.

## Verification

```bash
# No project-name tokens left
git grep -nE 'brave-agent|mcp__brave|brave-repl|com\.brave-agent|brave-profile'

# The browser references survived
git grep -cE 'BraveSoftware|Brave-Browser|brave-flags|brave-browser'   # expect 31

cd bridge && node --test          # expect all passing
cd ../plugin/repl && node --test *.test.mjs
```

Then a real turn through Slack, because the import guard catches a missing
import and nothing catches a plist pointing at a directory that moved.

## Rollback

Every step is reversible except the GitHub rename, which is reversible only
while nobody has claimed the freed name. Do that step last.
