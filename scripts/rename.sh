#!/usr/bin/env bash
#
# Rename the project from agentic-browser to agentic-browser.
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

# Longest first: com.agentic-browser must match before agentic-browser, or it becomes
# com.agentic-browser only by luck of the replacement order.
declare -a PAIRS=(
  'com.agentic-browser:com.agentic-browser'
  'mcp__browser-repl:mcp__browser-repl'
  'agentic-browser:agentic-browser'
  'browser-repl:browser-repl'
  'mcp__browser:mcp__browser'
  'browser-profile:browser-profile'
  'browser-setup:browser-setup'
)

# The MCP server key itself, which is the bare word and so cannot go in the
# list above: renaming every "brave" would eat the Brave browser paths. These
# three shapes are the key and nothing else - a JSON key, an object shorthand,
# and a quoted shorthand. Found by trial: renaming mcp__browser without this
# left the prefix derived from a key that no longer matched, and five tests
# failed on `mcp__browser` vs `mcp__browser`.
declare -a KEYS=(
  's/"browser":/"browser":/g'
  's/\bbrave: \{/browser: {/g'
  "s/'browser':/'browser':/g"
  's/\bbrave: \{\}/browser: {}/g'
)

# Tokens that are the Brave BROWSER and must survive untouched.
KEEP='BraveSoftware|Brave-Browser|Brave Browser|brave-browser|brave-flags|/Applications/Brave'

before_keep=$(git grep -ohE "$KEEP" -- . | wc -l | tr -d ' ')
echo "Brave-browser references to preserve: $before_keep"
echo

files=$(git grep -lE 'agentic-browser|browser-repl|mcp__browser|browser-profile|browser-setup|com\.agentic-browser|"browser":|\bbrave: \{' -- . || true)
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
    grep -qE '"browser":|\bbrave: \{|'"'"'brave'"'"':' "$f" 2>/dev/null || continue
    changed=1
    [ "$APPLY" = 1 ] && perl -pi -e "$rule" "$f"
  done
  [ "$changed" = 1 ] && echo "  $( [ "$APPLY" = 1 ] && echo rewrote || echo would rewrite ) $f"
done

# Files whose NAME carries the old project name.
echo
for old in \
  bridge/launchd/com.agentic-browser.bridge.plist \
  bridge/launchd/com.agentic-browser.browser.plist \
  bridge/launchd/com.agentic-browser.routines.plist \
  bridge/launchd/com.agentic-browser.dream.plist \
  bridge/systemd/agentic-browser.service \
  bridge/systemd/agentic-browser-routines.service \
  bridge/systemd/agentic-browser-routines.timer \
  plugin/commands/browser-setup.md
do
  [ -e "$old" ] || continue
  new=$(printf '%s' "$old" | sed -e 's/com\.agentic-browser/com.agentic-browser/' -e 's/agentic-browser/agentic-browser/' -e 's/browser-setup/browser-setup/')
  echo "  $( [ "$APPLY" = 1 ] && echo renamed || echo would rename ) $old -> $new"
  [ "$APPLY" = 1 ] && git mv "$old" "$new"
done

echo
if [ "$APPLY" = 1 ]; then
  after_keep=$(git grep -ohE "$KEEP" -- . | wc -l | tr -d ' ')
  echo "Brave-browser references after: $after_keep (was $before_keep)"
  [ "$after_keep" = "$before_keep" ] || { echo "REFUSING: the browser references changed. Revert with git checkout ."; exit 1; }
  left=$(git grep -nE 'agentic-browser|mcp__browser|browser-repl|com\.agentic-browser|browser-profile|"browser":' -- . || true)
  [ -n "$left" ] && { echo "Project-name tokens still present:"; echo "$left"; exit 1; }
  echo "Repo renamed. Now do the steps in docs/rename-to-agentic-browser.md that this does not touch."
else
  echo "Dry run. Re-run with --apply to write."
fi
