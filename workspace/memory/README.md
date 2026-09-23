# How this memory tree works

Where a thing goes, when to promote it, and what to do when nothing fits.
Adapted 2026-08-27 from the retired agent's `TAXONOMY.md`, which was written
from three months of getting these calls wrong.

Read this when you are about to write memory and are not sure where. Do not read
it to *find* something: retrieval must never depend on this file.

## The layers

| Layer | Where | Derived from |
|---|---|---|
| **L1**, always loaded | `CLAUDE.md`, `shared-CLAUDE.md` | everything below |
| **Semantic**, read on demand | `memory/<kind>/*.md` | episodic, plus direct observation |
| **Episodic**, dated raw | `memory/episodic/YYYY-MM-DD.md` | what actually happened |
| **Procedural** | `skills/<name>/SKILL.md` | repeated procedures |

**Semantic and episodic are the source of truth. L1 is derived from them.** If
L1 and a semantic page disagree, the semantic page is right and L1 is stale.

**L1 must stay small.** It is paid for on every session, so a fact earns its
place there only by being needed at the start of most tasks.

## Where it goes

| Kind | Directory |
|---|---|
| How he works, writes, expects to be treated | `users/` |
| Workspace ids, people, org facts | `companies/` |
| How this machine and its tools behave | `agent/` |
| How a specific site actually behaves | `sites/` |
| Ideas that outlive one company or tool | `concepts/` |
| Ongoing work with state and decisions | `projects/` |
| Recurring scheduled work | `routines/` |
| What happened, dated | `episodic/` |
| An ordered way to do something | `skills/` (not memory) |

`projects/`, `routines/` and `episodic/` each have their own README with the
rules that matter for that shape.

## Deciding where to write

1. **Is it durable past this session?** If not, do not write it at all. Most of
   what happens in a session is not memory.
2. **Is it an event, sparse, or uncertain?** Then it is episodic. Write the
   observation, and stop there. Sparse evidence is allowed to stay episodic.
3. **Did it change stable understanding?** Then also update the semantic page.
4. **Does a page already own this subject?** Update that page. Do not create a
   second one; that is how a tree becomes unsearchable.
5. **Is it a procedure rather than a fact?** It is a skill, not memory. Steps go
   in `skills/`, statements go in `memory/`.
6. **Does it fit nothing cleanly?** Put it in the closest durable home and add a
   friction note at the bottom of this file. Do not invent a directory to solve
   one item.

## Promotion

- **Episodic to semantic** when repeated observation or strong evidence makes it
  durable. One incident is not a pattern.
- **Semantic to L1** only when it changes default behaviour across many tasks,
  or is needed at the start of most sessions.
- **Never promote** one-off incidents, narrow site quirks, or anything uncertain.
- Not every episodic entry needs to produce a semantic page. Most will not.

## How to write

- **Merge, do not append.** Edit the existing section. A tree that grows by
  accretion stops being read, and then it may as well not exist.
- **Date anything that supersedes**, and delete what it replaces. Keep a
  superseded figure only while people still quote it, and label it as wrong.
- **Use the `Edit` tool, never a scripted string replace.** `Edit` fails loudly
  when its target is missing; `str.replace()` silently does nothing and exits 0.
- **Re-read before editing** anything you did not write this session. Two agents
  write here.
- **No em dashes.** A pre-commit hook rejects them. Colon, comma, or rewrite.
- **No secrets.** No passwords, tokens, TOTP or backup codes, ever. Point at the
  password manager instead. This tree is read by an agent that also reads
  arbitrary web pages.
- **Escape non-ASCII inside stored code.** A regex holding literal
  high-codepoint characters reads fine here and breaks whatever carries it out.
  Write the `\uXXXX` form so a snippet copied from memory still runs. 2026-08-27.

## Size discipline

The system this came from reached 2.5MB, including a single 239KB project file
and 1.6MB of episodic memory. Nothing could read it, so in practice it was a
write-only archive that cost effort to maintain and returned nothing.

Rough ceilings, not laws: a semantic page under 10KB, an episodic day under 8KB,
L1 under 6KB. Passing one is a signal that the page is holding several subjects,
or that distilled facts are buried in narrative.

**Over the ceiling, cut subjects, not adjectives.** Distilling a 245KB source on
2026-08-27, three passes of tightening wording moved 15KB to 14KB. Only dropping
whole topics reached the target. Decide what the page is not about, then delete
that.

## Changing this file

Clarify wording when the same ambiguity comes up twice. Add a directory only
when several durable items have no clean home, never for one. Update the routing
rules and the directory table together, or they drift apart.

## Friction notes

Cases where the right home was genuinely unclear, and what was decided. These
exist so the same argument is not had twice.

- **A reusable method inside company-specific content.** A workshop framework
  often contains a genuinely portable method wrapped in one company's rollout
  detail. Split it: the method to `concepts/`, the rollout facts to
  `companies/`, cross-linked. Precedent from the source system:
  `concepts/okr-review-framework.md` split out of `companies/<company>.md`.
- **Persona content filed under autonomy.** The source system put character,
  tone and length rules into `agent/autonomy-and-approval.md` because they
  happened to share a source file with the autonomy instructions. Wrong reason
  to co-locate. Here the persona lives in `~/.config/agentic-browser/persona.md`,
  outside memory entirely, and `agent/autonomy.md` covers only how much to do
  before asking.
- **A recurring job described as a company fact.** `bixgrow-payouts.md` sat in
  `companies/` while describing a procedure with a failure history. Moved to
  `routines/` on 2026-08-26, which is also what made its log discipline apply.
