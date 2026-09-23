---
name: google-calendar
description: Read, create and change events in Google Calendar through the browser, including out-of-office days. Use whenever a task mentions the calendar, a meeting, availability, OOO, time off, a public holiday, or scheduling something.
---

# Google Calendar in the browser

There is no Calendar API tool. The browser is the only path, and the user's
profile is already signed in.

Verified 2026-08-25 against the live UI.

## Get to it

Check for an open tab first, it is usually already there:

```
browser_tabs (action: list)     -> look for calendar.google.com
browser_tabs (action: select)   -> switch to it
```

Otherwise `browser_navigate` to `https://calendar.google.com/calendar/u/0/r/week`.

## Two quirks that will mislead you

**The page logs ~190 console errors as normal operation.** They are not a
failure and not worth reading. Do not treat a console error count as a signal
that something went wrong.

**A full-page snapshot is enormous.** Use `browser_find` with the text you are
looking for; it returns just the matching nodes and their refs. Do not capture
the whole tree to locate one button. `browser_snapshot` with a `filename` was
observed writing no file at all, so do not rely on saving a snapshot to disk
either. To read one region cheaply, pass `target` with the container's ref.

## Marking a day out of office

**The single most important thing: the event is not real until you click Save.**

Until then the calendar shows the event with the label
`"Event is being created."` in its accessible name. Observed 2026-08-25: a
previous run filled the whole dialog correctly, never clicked Save, and
reported that nothing had been marked, while a half-created event sat on the
calendar looking plausible. If you see `Event is being created.` the task is
**not** done.

### The flow

1. Open the create dialog. The top-left **Create** button opens a menu with
   Event / Task / Out of office / Appointment schedule. Note that this button
   renders as `[disabled]` whenever a create dialog is already open, so if it
   looks disabled, a dialog is already on screen: find it with
   `browser_find` for `Create` and work with that rather than trying to open a
   second one.

2. Select the **Out of office** tab. The dialog has a `tablist` with three
   tabs, Event, Task and Out of office. Confirm the right one shows
   `[selected]` before filling anything in.

3. The title textbox pre-fills with `Out of office`. Leave it unless the user
   asked for specific wording.

4. Set the date range. It is a single button showing
   `Tuesday, August 25 – Tuesday, August 25`, not two separate date fields.
   For a one-day OOO on today's date it is already correct.

5. **Check the auto-decline settings before saving.** See the warning below.

6. Click Save, then verify.

### `browser_click` does not work on this page. Use `mcp__devtools__click`.

This is the single biggest time sink here, verified 2026-08-25 across three
separate attempts on two different elements.

`browser_click` fails with:

```
TimeoutError: ... waiting for element to be visible, enabled and stable
```

The locator **resolves** every time; it is the *stability* check that never
passes, because something on the Calendar page animates continuously. It is not
a wrong ref, not a timing problem, and retrying does not help. Waiting longer
does not help either.

**Use the other browser server instead.** You have two attached to the same
Brave: `mcp__browser__*` (Playwright) and `mcp__devtools__*` (chrome-devtools-mcp).
They see the same tabs and the same pages.

chrome-devtools-mcp dispatches clicks over CDP without Playwright's
actionability preconditions, so the stability gate never applies:

```
mcp__devtools__take_snapshot      -> gives uids, e.g. uid=1_21 button "Create"
mcp__devtools__click  uid=1_21    -> "Successfully clicked on the element"
```

Measured 2026-08-25 on this exact button: Playwright failed three times,
devtools clicked first try, twice, in two separate sessions.

Note the two servers use **different element identifiers**. Playwright gives
`[ref=e123]`, devtools gives `uid=1_21`. A ref from one is meaningless to the
other, so snapshot with whichever server you are about to act with.

Reading is still cheaper and richer with `mcp__browser__browser_snapshot` or
`browser_find`. A reasonable split on this site: read with brave, click with
devtools.

`browser_evaluate` against a specific ref also works and is still allowed, but
prefer `mcp__devtools__click`: it is a real input dispatch rather than a
synthetic DOM call, so it exercises the same code path a person would.

Do **not** escalate to coordinate clicking. `browser_run_code_unsafe` is denied
at the harness and no longer available to you; that is deliberate. A previous
run used it against a half-open dialog and left a ghost "No title" out-of-office
event on the calendar that had to be hunted down and deleted.

`browser_evaluate` against a **specific ref** is the supported escape hatch and
is what the pattern above uses. The difference that matters: it is scoped to one
element you have already located and verified, not a free script over the page.

### Do not reach for the `c` keyboard shortcut

`c` opens the full event editor at `/r/eventedit`. That editor has **no Out of
office tab** at all: its tabs are Guests / Event details / Find a time. It also
frequently renders blank for several seconds. It is the wrong surface. Press
Escape to get out and use the Create menu.

### Element names in the dialog

When the dialog is fully rendered, `Save` and the radios **do** have proper
accessible names: `button "Save"`, `radio "Only new meeting invitations"`,
`radio "New and existing meetings"`, `checkbox "Automatically decline meetings"`.

If you snapshot and find those buttons unlabelled, the dialog has not finished
rendering. Wait and re-snapshot rather than trying to locate them by position.

### Verify after saving

`browser_find` for the event on that date and read its accessible name. It is
saved when the name no longer contains `Event is being created.` If that string
is still there, it did not save, whatever the click appeared to do.

## Auto-decline reaches other people. Ask first.

An out-of-office event carries an **Automatically decline meetings** checkbox,
checked by default, with a radio group:

- `Only new meeting invitations`
- `New and existing meetings` (the default)

`New and existing meetings` **sends declines to the organisers of meetings
already on the calendar**. That is an outbound action to people outside this
session, and it is not something you can quietly undo.

So: marking a day OOO is internal and you should just do it. But if
auto-decline is on and set to include existing meetings, and that day already
has accepted meetings, **say so and get a yes before saving**. Name the
meetings that would be declined.

If the user only wants the day blocked without cancelling anything, either uncheck
auto-decline or switch the radio to `Only new meeting invitations`.

The decline message is editable in the same dialog; it defaults to
`Declined because I am out of office`.

## Public holidays

The the company calendar subscribes to `Holidays in Indonesia`, so a public holiday
already appears as an all-day event, for example
`Maulid Nabi Muhammad, Calendar: Holidays in Indonesia`.

A holiday showing up there does **not** mark the user out of office. It is a
separate read-only calendar. If he asks to be marked OOO for a holiday, you
still create the out-of-office event.
