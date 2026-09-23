---
description: Configure a Chromium browser (Chromium, Chrome, Brave, Edge) on Linux or macOS so Claude Code can drive the user's real logged-in profile over CDP
argument-hint: "[--revert]"
---

Set up (or undo) agentic control of the user's real browser.

Any Chromium will do: Chromium, Chrome, Brave, Edge. Nothing downstream is
Brave-specific - the repl server talks CDP, and `browser.mjs` finds the browser
by the `--cdp-endpoint`/`--browserUrl` flag in the MCP config rather than by
name. Ask which browser holds the logins that matter before choosing.

**Chromium is the better target where there is a choice.** Brave's Shields
rewrite the page, so the accessibility tree the agent snapshots is not the one
the site served, and its fingerprint randomisation makes each session look
different, which is the opposite of what a stable logged-in user looks like.
Chromium is also what CDP and Playwright are developed against.

If the argument is `--revert`, skip to **Reverting** at the end.

Work through this in order. Report what you find at each step rather than
assuming the defaults hold.

The shape is the same everywhere: find the profile, move it off the default
path, launch with `--remote-debugging-port`, verify. Only the paths and the
launcher differ, and each step says where.

| | Linux | macOS |
|---|---|---|
| binary | `chromium` / `google-chrome` / `brave` (Arch) / `brave-browser` (Debian) | `/Applications/<Browser>.app/Contents/MacOS/<Browser>` |
| user data | `~/.config/chromium`, `~/.config/google-chrome`, `~/.config/BraveSoftware/Brave-Browser` | `~/Library/Application Support/<Chromium\|Google/Chrome\|BraveSoftware/Brave-Browser>` |
| flags | `~/.config/<browser>-flags.conf`, read by every launcher | no flags file; the launcher must pass them |
| service | systemd user units | launchd agents |

**macOS runs one instance per app bundle.** If that browser is already running
without the debug flag, a second launch does not start a browser - it hands its
command line to the running one and exits, leaving no port and no
`DevToolsActivePort` file. Seen on this machine: four flag combinations all
failed until every instance was quit. Linux keys the singleton to
`--user-data-dir`, so a second profile just starts. Check `pgrep` before
concluding the flags are wrong.

## 1. Establish the facts first

```bash
# Linux: whichever is installed
for b in chromium google-chrome brave brave-browser microsoft-edge; do
  command -v "$b" >/dev/null && echo "$b -> $("$b" --version 2>/dev/null)"
done
ls -d ~/.config/chromium ~/.config/google-chrome ~/.config/BraveSoftware/Brave-Browser 2>/dev/null
pgrep -a 'chromium|chrome|brave' | head -3

# macOS
ls -d /Applications/*.app | grep -iE 'chromium|chrome|brave|edge'
ls -d ~/Library/Application\ Support/{Chromium,Google/Chrome,BraveSoftware/Brave-Browser} 2>/dev/null
pgrep -a -f 'Chromium|Google Chrome|Brave Browser' | head -3
```

You need four things: the binary, the architecture (`uname -m`), whether a
profile already exists, and whether Brave is currently running.

**If no profile exists**, stop and ask the user to launch Brave and sign in to
the sites they care about first. A profile with no sessions makes this pointless.

## 2. Which profile directory is which

Inside the user data directory, profiles are directories (`Default`,
`Profile 1`…) whose display names live in `Local State`. Never assume `Default`
is the one they mean.

```bash
python3 -c "
import json,os,sys
mac=os.path.expanduser('~/Library/Application Support/BraveSoftware/Brave-Browser')
lin=os.path.expanduser('~/.config/BraveSoftware/Brave-Browser')
base=mac if os.path.isdir(mac) else lin
d=json.load(open(os.path.join(base,'Local State')))['profile']
for k,v in d.get('info_cache',{}).items(): print(k,'->',v.get('name'))
print('last_used:', d.get('last_used'))
"
```

If there is more than one, **ask which profile the agent should drive.** Getting
this wrong means acting in the wrong identity. `last_used` tells you which one
the human opens, which is not necessarily the one the agent should hold: compare
the cookie counts (step 5) for the sites the agent actually needs.

## 3. Move the profile out of the default path

Chromium 136+ refuses `--remote-debugging-port` when the profile sits at the
**default** path. This is the step people miss, and the symptom is a debug port
that silently never opens. It applies on both platforms.

Ask the user to quit Brave completely, confirm with `pgrep`, then:

```bash
# Linux
mv ~/.config/BraveSoftware/Brave-Browser ~/.local/share/browser-profile

# macOS
mv ~/Library/Application\ Support/BraveSoftware/Brave-Browser ~/.local/share/browser-profile
```

Same filesystem, so it is instant. Cookies stay decryptable because the secret
that encrypts them is unchanged: the OS keyring entry on Linux, the
`Brave Safe Storage` Keychain item on macOS. Do **not** copy to a different
machine or user, on either platform.

## 4. Add the flags

### Linux

Check whether the launcher reads a flags file. On Arch, `/usr/bin/brave` is a
shell script that sources `$XDG_CONFIG_HOME/brave-flags.conf` and prepends
whatever it finds:

```bash
head -20 $(command -v brave)
```

**If it does**, append to `~/.config/brave-flags.conf`. This is much better than
a wrapper script or editing `.desktop` files, because every launcher inherits
it: the desktop entry, any web-app entries, and the user's own shell.

```
--user-data-dir=/home/USER/.local/share/browser-profile
--remote-debugging-port=9222
--profile-directory=Default
```

Substitute the real home path (no `~`, it is not expanded) and the profile
directory chosen in step 2.

**If it does not**, create a wrapper, but check PATH order first, because
`~/.local/bin` is often placed *after* `/usr/bin` and then shadows nothing:

```bash
python3 -c "
import os;p=os.environ['PATH'].split(':')
h=os.path.expanduser('~/.local/bin')
print('local/bin', p.index(h) if h in p else 'absent', '| /usr/bin', p.index('/usr/bin'))
"
```

### macOS

There is no flags file, and this is the one place the two platforms genuinely
diverge rather than just renaming a path. LaunchServices starts the app bundle
directly, so **a Dock or Spotlight launch passes no arguments and the debug port
does not open.** Nothing you can put in a config file changes that. The flags
have to come from whatever starts the browser, so make one thing start it.

A launchd agent at login, which is also what keeps the port open across reboots:

```bash
mkdir -p ~/Library/LaunchAgents
cat > ~/Library/LaunchAgents/com.agentic-browser.browser.plist <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>com.agentic-browser.browser</string>
    <key>ProgramArguments</key>
    <array>
        <string>/Applications/Brave Browser.app/Contents/MacOS/Brave Browser</string>
        <string>--user-data-dir=$HOME/.local/share/browser-profile</string>
        <string>--remote-debugging-port=9222</string>
        <string>--profile-directory=Default</string>
    </array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><false/>
</dict>
</plist>
PLIST
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.agentic-browser.browser.plist
```

`KeepAlive` is deliberately false: the user must stay able to quit their own
browser without launchd reopening it under them.

Substitute the profile directory chosen in step 2. Note `$HOME` is expanded by
the heredoc above, so the plist ends up holding a real path. launchd does **not**
expand `~` or `$HOME` itself.

Then shadow the Dock launch so a cold start from anywhere still gets the flags:

```bash
cat > ~/.local/bin/brave <<'SH'
#!/bin/sh
exec open -na "Brave Browser" --args \
  --user-data-dir="$HOME/.local/share/browser-profile" \
  --remote-debugging-port=9222 \
  --profile-directory=Default
SH
chmod +x ~/.local/bin/brave
```

Tell the user plainly: launch Brave from the Dock **after** a full quit and the
port will not be there. Either use this wrapper, or log out and back in.

## 5. Verify CDP actually opened

```bash
curl -s http://127.0.0.1:9222/json/version | head -5
```

Expect JSON with `Browser` and `webSocketDebuggerUrl`. Then confirm it is the
*intended profile*, not a fresh one. Navigate to `brave://version` and read the
`Profile Path` line, or check the cookie count:

```bash
python3 -c "
import sqlite3,shutil,os,tempfile
src=os.path.expanduser('~/.local/share/browser-profile/Default/Cookies')
t=tempfile.mktemp(); shutil.copy(src,t)
c=sqlite3.connect(t)
print('cookies:', c.execute('select count(*) from cookies').fetchone()[0])
for d in ('slack.com','google.com'):
    n=c.execute('select count(*) from cookies where host_key like ?', ('%'+d,)).fetchone()[0]
    print(' ',d,n)
"
```

A near-zero cookie count means you are looking at the wrong profile.

## 5b. Install the two local servers' dependencies

`brave` and `devtools` come from npm at run time via `npx`. The other two,
`browser-repl` and `memory`, are files in this plugin, and `node_modules/` is not
shipped inside it. Without this step they fail to start and you lose `snapshot`,
`act`, `fetch` and the site notes, leaving only the two npx servers:

```bash
npm --prefix "$CLAUDE_PLUGIN_ROOT/repl" install
npm --prefix "$CLAUDE_PLUGIN_ROOT/memory" install
```

Check they start. Each should print its tool list and then wait:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  | node "$CLAUDE_PLUGIN_ROOT/repl/server.mjs"
```

An `ERR_MODULE_NOT_FOUND` here means the install above did not run.

## 6. Stop the browser stealing focus

Every CDP tab-select and navigate makes the browser ask the window manager to
raise itself, which interrupts the user constantly.

### Linux (Hyprland)

```bash
hyprctl getoption misc:focus_on_activate
```

If `true`, offer to set it false in the user's Hyprland config, and **state the
trade-off**: it is global, so links clicked in other apps will no longer switch
to the browser either. Hyprland has no per-app rule for activation requests.

Optionally also pin the browser to one workspace so agent activity stays off
whatever the user is looking at:

```lua
o.window("^brave-browser$", { workspace = "2 silent" })
```

`silent` is the load-bearing half. Without it, opening Brave drags them there.
Anchor the class: web-app windows are a different class
(`brave-app.slack.com__client-Default`) and should not be moved.

On GNOME or KDE the equivalent is a focus-stealing-prevention setting.

### macOS

There is no equivalent switch, so do not pretend there is one. macOS has no
focus-stealing-prevention setting and no per-app activation rule. What actually
helps is putting the agent's Brave window on its own Space and turning off
System Settings → Desktop & Dock → **Automatically rearrange Spaces based on
most recent use**, so the agent raising a window does not reshuffle the Spaces
the user is navigating by muscle memory.

## 7. Confirm the MCP servers see it

The plugin registers four: `brave` (Playwright) and `devtools`
(chrome-devtools-mcp), both pointing at `127.0.0.1:9222`, plus `browser-repl` and
`memory` from this plugin's own directory. Verify with `claude mcp list`, then
list tabs through `mcp__browser__browser_tabs` and confirm the user's real tabs
appear.

`browser-repl` is the one worth checking separately, since it is where `snapshot`,
`act` and `fetch` live: `mcp__browser-repl__pages` should list the same tabs.

Newly registered MCP servers do not expose their tools to an already-running
session. If the tools are missing, the session needs restarting.

## Tell the user what they just enabled

Be direct about it. The debug port is open for every Brave launch from now on.
It binds to `127.0.0.1` only, but **any process running as this user can drive
the browser with all of its logged-in sessions**. That is inherent to the design,
not incidental. It is the same exposure any agentic browser has, and they should
know it is on.

## Reverting

Two changes, both reversible in a minute.

**Linux:**

1. Delete the added lines from `~/.config/brave-flags.conf`.
2. `mv ~/.local/share/browser-profile ~/.config/BraveSoftware/Brave-Browser`

Plus, if they were added: the Hyprland `focus_on_activate` and workspace rules.

**macOS:**

1. `launchctl bootout gui/$(id -u)/com.agentic-browser.browser` and delete
   `~/Library/LaunchAgents/com.agentic-browser.browser.plist`.
2. `rm ~/.local/bin/brave`
3. `mv ~/.local/share/browser-profile ~/Library/Application\ Support/BraveSoftware/Brave-Browser`
