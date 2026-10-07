# Memory sync across machines

Status: design, awaiting review. 2026-10-07.

## Goal

What an agent learns on one machine reaches the others without anyone pushing
by hand. No change is silently lost, and nothing private leaves private storage.

## Machines

| Machine | Runs | Role in sync |
|---|---|---|
| Mac A (current) | Aside, Hammock, Tara | read and write every store |
| Mac B | Aside, Hammock, Tara | read and write every store |
| Omarchy (Linux) | Hammock on Brave | read and write Hammock and Tara; Aside pull-only |

Aside does not run on Linux. Omarchy gets a read-only copy of Aside's notes.

Assumption: each agent answers Slack from one machine at a time. Socket Mode
delivers every mention to every connected bridge, so two copies of one agent
would both answer each message (see `bridge/lock.mjs`). Memory is shared; the
running agent is not.

Layout requirement: on every machine `hammock-memory/` and `tara-workspace/`
are siblings in one folder (on the Macs, `~/Documents/A1C/agent/`). Tara's links
into Hammock's tree are relative, so they resolve on any machine with that
layout.

## Stores

Every store is a private GitHub repo. The sync never touches a public repo.

| Store | Repo | Tracked | Never tracked |
|---|---|---|---|
| Hammock | `hammock-memory` (exists) | `CLAUDE.md`, `skills/`, `scripts/`, `memory/` | `transcripts/` and what its `.gitignore` already excludes |
| Tara | `tara-memory` (new) | `CLAUDE.md`, `memory/` (her notes, routines, and `shared/` with its links and `INDEX.md`), `skills/` (links and her own skills), the `.claude/skills` link | `transcripts/`, `memory/repo-sync.md` (per machine), anything else in `.claude/` |
| Aside | `aside-memory-u0`, `aside-memory-u3` (new) | `**/*.md` | `.history.jsonl`, `.local-memory/`, `memory-index-local.json` |

Tara's repo uses `tara-workspace/` as its work tree with an allowlist
`.gitignore` (ignore everything, then un-ignore the tracked paths), so a new
file in her workspace is private until someone decides otherwise. Her links are
tracked as relative symlinks: which of Hammock's notes she may read is itself a
decision worth syncing. Setup converts today's absolute links once.

Each Aside account gets its own repo, because git cannot map a subfolder of
one repo onto the root of a work tree. The git directory lives outside Aside's
folders (`~/.local/share/agent-sync/aside-u0.git`, `aside-u3.git`) with
`core.worktree` pointing at `~/.aside/u/<n>/memory`, so nothing new appears
inside a folder Aside owns.

## Code and config

- `sync/` in this repo: `sync.mjs` (one pass over every store), `aside-guard.mjs`
  (the lost-update check), `secrets.mjs` (the scan), `setup.mjs`, and unit files
  for launchd and systemd. Node only, no dependencies beyond git.
- `sync/sync.config.json`, gitignored, one per machine. `sync.config.example.json`
  shows the shape:

```json
{
  "machine": "mac-a",
  "intervalMinutes": 5,
  "stores": [
    { "name": "hammock", "workTree": "~/Documents/A1C/agent/hammock-memory", "remote": "<private repo url>", "mode": "readwrite" },
    { "name": "tara", "workTree": "~/Documents/A1C/agent/tara-workspace", "remote": "<private repo url>", "mode": "readwrite" },
    { "name": "aside-u0", "workTree": "~/.aside/u/0/memory", "gitDir": "~/.local/share/agent-sync/aside-u0.git", "remote": "<private repo url>", "mode": "readwrite", "aside": true }
  ]
}
```

On Omarchy the Aside stores have `"mode": "pull"` and a `workTree` under
`~/.local/share/agent-sync/`, since there is no Aside folder to write into.

## The pass

`sync.mjs` runs once and exits. A timer starts it every `intervalMinutes`. A
lock file (`$XDG_STATE_HOME/agent-sync/sync.lock`, same scheme as the bridge
lock) stops two passes overlapping. For each store, independently:

1. Skip it if it is stopped (see Failure). One stopped store never blocks the
   others.
2. Aside stores only: run the lost-update check (below) for runs finished since
   the last pass.
3. `readwrite` only: stage changes. Run the secret scan on the staged diff; on a
   hit, unstage, stop the store and report the file and pattern name, never the
   matched text. Otherwise commit as `sync from <machine>` if anything is staged.
4. Fetch. Merge the remote branch with `--no-edit`. Rebase is not used: a
   merge never rewrites commits another machine may already hold.
5. On a conflicted merge: `git merge --abort`, stop the store, report the
   conflicted paths. The work tree is left exactly as before the merge.
6. `readwrite` only: push. A rejected push (another machine pushed first) is
   retried once from step 4 in the same pass; a second rejection waits for the
   next pass.
7. Record the store's result in the status file.

### Merge rules

`.gitattributes` in each repo:

- `episodic/*.md merge=union`. Daily logs only ever gain lines, so keeping both
  sides is right. Union can duplicate a line both machines added identically;
  that is accepted.
- Everything else uses git's normal three-way merge. Two machines editing
  different parts of a note merge cleanly; the same lines on both sides is a
  conflict and stops the store.

## Aside lost-update check

Aside rewrites notes after each of its sessions, with no lock on the markdown.
A run reads a note, works for 5 to 150 seconds, then writes it. If a sync merge
changes the note in between, Aside's write is based on the older version and
would undo the merge. The next commit would then send that undo to every
machine.

Each line of `.history.jsonl` is one run with `startedAt`, `finishedAt` and
`changes[]`. Each change has `path`, `beforeSha256`, `beforeContent` and
`afterContent`. The check:

1. Whenever a merge changes a file in an Aside work tree, the pass records a
   write: `path`, `preSha` (SHA-256 of the file just before), `postBlob` (the
   git blob id written) and `writtenAt`. Writes are kept for 24 hours in the
   store's state file.
2. Read runs with `finishedAt` after the last checked run. The state file keeps
   the byte offset reached; the log only grows. A shrunk log resets the offset
   to 0 and rechecks.
3. A change is a lost update when a recorded write exists for its `path` with
   `preSha` equal to the change's `beforeSha256` and `writtenAt` between the
   run's `startedAt` and `finishedAt`. Aside read the file before the sync wrote
   it and saved after. A change with a null `beforeSha256` (a new note) is never
   one.
4. For a lost update, run `git merge-file` with base `beforeContent`, ours the
   file as it is now (Aside's write) and theirs the `postBlob` content. A clean
   result is written back with an atomic rename and committed by the normal
   pass. A conflicted one stops the store, leaves Aside's file untouched and
   reports the path.
5. This check runs before staging (pass step 2), so an undo is never committed.

Writing back is itself a write into Aside's folder, so the same check covers it
on the next pass.

Aside's index picks up file changes on its own (the daemon logs
"synced in Rust process" after edits), so no reindex call is needed.

## Failure

- A stopped store is recorded in `$XDG_STATE_HOME/agent-sync/stopped/<store>`
  with the reason. It stays stopped until that file is deleted, by hand or by
  `sync.mjs --resume <store>` after the cause is fixed.
- Every stop raises one desktop notification on that machine
  (`osascript` on macOS, `notify-send` on Linux). Not repeated each pass.
- Network failures (fetch or push) do not stop a store: they are logged and the
  next pass retries.
- `status.json` in the same folder lists each store: last success time, last
  result, stopped reason if any. Hammock and Tara can read it to know how fresh
  their memory is.

## Setup per machine

`setup.mjs`:

1. Reads `sync.config.json`.
2. Clones each store that is missing. For Aside on a Mac whose Aside already has
   notes, the first run commits the local notes and merges the remote, so two
   Macs that learned separately combine on day one; conflicts stop the store as
   usual.
3. Converts any absolute link in Tara's workspace that points into the shared
   parent folder to a relative one. Links pointing elsewhere are left alone and
   listed.
4. Installs and loads the timer: `~/Library/LaunchAgents/com.agent-sync.plist`
   (started under node, since launchd's bash is refused access to ~/Documents)
   or `~/.config/systemd/user/agent-sync.{service,timer}`.

Creating the two new private GitHub repos is a manual step, listed in the
setup output, not done by the script.

## Out of scope

- Claude Code's own memory (`~/.claude/projects/*/memory`) and Claude config.
- Aside's learning log, search index, browsing history and logins.
- Running one agent on two machines at once.
- Real-time sync. Five minutes is the target latency.

## Testing

`node --test sync/*.test.mjs`, using temporary bare repos as the remote and two
temporary clones as two machines:

- a change on one machine appears on the other after one pass each;
- both machines add lines to the same episodic file: both kept;
- both edit the same line of a note: the store stops, both work trees unchanged,
  the other stores still sync;
- a staged file containing a token pattern: nothing committed, store stopped,
  report names the file and pattern, not the value;
- a rejected push retries once and succeeds;
- lost update: a fake `.history.jsonl` run whose `beforeSha256` matches an older
  blob triggers a three-way merge that keeps both the incoming and Aside's
  change; a run based on the current blob does nothing;
- `pull` mode never commits or pushes;
- a stopped store resumes only after `--resume`.
