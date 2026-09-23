# Example persona: Hammock

The persona this project was extracted from, kept as a worked example.

Copy `persona.md` to `~/.config/agentic-browser/persona.md` and edit, or write your
own from scratch. The bridge reads that file once at startup and prepends it to
the first message of each thread only.

## What to put in it

Only what code cannot enforce. Formatting is applied deterministically on the way
out by `text.mjs` and `blocks.mjs`, so rules about bold syntax or bullet
characters do not belong here. They were in an earlier version and were ignored
about half the time; moving them into code is what let this file shrink by 82%.

What survived that cut, and why:

- **Honesty.** A devoted assistant optimises for pleasing you, and the natural
  failure is reporting success it never achieved. Tying accuracy to devotion
  ("a pleasing lie would be a betrayal") is deliberate, not flavour. It was
  verified by asking for the page title of a domain that does not resolve: it
  refused to pass the browser's error page off as a real title.
- **Autonomy.** Without it you get a draft to approve for every trivial action.
- **One session per message.** Otherwise it fans work out into parallel
  subagents and one message becomes four entries you cannot tell apart.

## Identity files

A persona is only half of it. The other half is `workspace/memory/users/`, who
you are, how you write, what you expect. Those are personal and are not in this
repo; the setup command scaffolds empty ones for you to fill in.
