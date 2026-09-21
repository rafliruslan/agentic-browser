#!/usr/bin/env bash
#
# Rename the project from brave-agent to agentic-browser.
#
# Dry run by default. Pass --apply to write.
#
# Renames by TOKEN, never by substring. 31 occurrences of "brave" in this repo
# are the Brave browser itself - BraveSoftware, Brave-Browser, brave-flags.conf,
# the macOS bundle - and Brave is still a supported target. A substring rename
# corrupts every one of them, and does it quietly: the setup command would send
# a Brave user to a directory that has never existed.
#
# Repo only. The state directories, the launchd plists and the GitHub rename are
# in docs/rename-to-agentic-browser.md and are deliberately not automated: they
# need the agents stopped first, and a half-applied migration is worse than none.
set -euo pipefail

cd "$(dirname "$0")/.."

APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1

# Longest first: com.brave-agent must match before brave-agent, or it becomes
# com.agentic-browser only by luck of the replacement order.
declare -a PAIRS=(
  'com.brave-agent:com.agentic-browser'
  'mcp__brave-repl:mcp__browser-repl'
  'brave-agent:agentic-browser'
  'brave-repl:browser-repl'
  'mcp__brave:mcp__browser'
  'brave-profile:browser-profile'
  'brave-setup:browser-setup'
)

# The MCP server key itself, which is the bare word and so cannot go in the
# list above: renaming every "brave" would eat the Brave browser paths. These
# three shapes are the key and nothing else - a JSON key, an object shorthand,
# and a quoted shorthand. Found by trial: renaming mcp__brave without this
# left the prefix derived from a key that no longer matched, and five tests
# failed on `mcp__brave` vs `mcp__browser`.
declare -a KEYS=(
  's/"brave":/"browser":/g'
  's/\bbrave: \{/browser: {/g'
  "s/'brave':/'browser':/g"
  's/\bbrave: \{\}/browser: {}/g'
)

# Tokens that are the Brave BROWSER and must survive untouched.
KEEP='BraveSoftware|Brave-Browser|Brave Browser|brave-browser|brave-flags|/Applications/Brave'

before_keep=$(git grep -ohE "$KEEP" -- . | wc -l | tr -d ' ')
echo "Brave-browser references to preserve: $before_keep"
echo

files=$(git grep -lE 'brave-agent|brave-repl|mcp__brave|brave-profile|brave-setup|com\.brave-agent|"brave":|\bbrave: \{' -- . || true)
[ -z "$files" ] && { echo "Nothing to rename."; exit 0; }

for f in $files; do
  changed=0
  for pair in "${PAIRS[@]}"; do
    from=${pair%%:*}
    to=${pair##*:}
    grep -q -- "$from" "$f" 2>/dev/null || continue
    changed=1
    [ "$APPLY" = 1 ] && perl -pi -e "s/\Q$from\E/$to/g" "$f"
  done
  for rule in "${KEYS[@]}"; do
    grep -qE '"brave":|\bbrave: \{|'"'"'brave'"'"':' "$f" 2>/dev/null || continue
    changed=1
    [ "$APPLY" = 1 ] && perl -pi -e "$rule" "$f"
  done
  [ "$changed" = 1 ] && echo "  $( [ "$APPLY" = 1 ] && echo rewrote || echo would rewrite ) $f"
done

# Files whose NAME carries the old project name.
echo
for old in \
  bridge/launchd/com.brave-agent.bridge.plist \
  bridge/launchd/com.brave-agent.browser.plist \
  bridge/launchd/com.brave-agent.routines.plist \
  bridge/launchd/com.brave-agent.dream.plist \
  bridge/systemd/brave-agent.service \
  bridge/systemd/brave-agent-routines.service \
  bridge/systemd/brave-agent-routines.timer \
  plugin/commands/brave-setup.md
do
  [ -e "$old" ] || continue
  new=$(printf '%s' "$old" | sed -e 's/com\.brave-agent/com.agentic-browser/' -e 's/brave-agent/agentic-browser/' -e 's/brave-setup/browser-setup/')
  echo "  $( [ "$APPLY" = 1 ] && echo renamed || echo would rename ) $old -> $new"
  [ "$APPLY" = 1 ] && git mv "$old" "$new"
done

echo
if [ "$APPLY" = 1 ]; then
  after_keep=$(git grep -ohE "$KEEP" -- . | wc -l | tr -d ' ')
  echo "Brave-browser references after: $after_keep (was $before_keep)"
  [ "$after_keep" = "$before_keep" ] || { echo "REFUSING: the browser references changed. Revert with git checkout ."; exit 1; }
  left=$(git grep -nE 'brave-agent|mcp__brave|brave-repl|com\.brave-agent|brave-profile|"brave":' -- . || true)
  [ -n "$left" ] && { echo "Project-name tokens still present:"; echo "$left"; exit 1; }
  echo "Repo renamed. Now do the steps in docs/rename-to-agentic-browser.md that this does not touch."
else
  echo "Dry run. Re-run with --apply to write."
fi
