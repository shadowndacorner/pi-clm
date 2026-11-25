---
name: clm-live-context
description: Keep your own context precise by editing the pi-clm mirror in place — trim spent tool output and superseded work where it sits, keep the conversation's structure, and reserve whole-context rewrites for real capacity pressure.
---

# Tending your live context

pi-clm writes the exact conversation you will see on your next request to the mirror path named
in the `## Editable context` section of your system prompt. Editing that file is how you change
what you will remember. Everything below is about doing it locally, in place, close to the work
that made the material redundant.

## The default operation: a tidy pass

TIDY is optional. If nothing in the context is demonstrably redundant, write nothing. A tidy pass
shortens or replaces block **bodies** where they sit, keeps every header you retain, and leaves
every other block byte-identical.

Act on events, not on a feeling that the context is untidy:

- a large tool result whose facts you have already extracted — collapse it to what it was and
  what it proved, in place;
- a long reasoning or analysis turn whose conclusion is now recorded elsewhere — keep the
  conclusion in that block, drop the working;
- a task switch — the superseded thread's tool churn is the first thing to trim;
- files you re-read often: keep the path plus a one-line index instead of the content.

Do not tidy after every turn. One write per turn, carrying as many disjoint local patches as the
revision needs. Batch means many localized patches in one write — never one synthetic summary of
the conversation.

## The self-test

Before writing, answer both questions. If either fails, do not make that edit.

1. **Which exact ids change, and what observed fact makes what I remove spent, superseded,
   duplicated, or recoverable from a file?** If you cannot name the fact, leave the block alone.
2. **Does the diff preserve every other body, all live owner requirements, unresolved work,
   exact identifiers, and evidence that cannot be recovered?**

Prefer leaving something oversized in place over guessing. A block that is too big costs tokens; a
block you deleted wrongly costs the task.

## Use the checked helper

```bash
python3 <skill directory>/scripts/clm-tidy.py --file "<mirror path>" --list
python3 <skill directory>/scripts/clm-tidy.py --file "<mirror path>" \
  --patch 41-9f3c1a2b7d40="test suite: 3 passed, T12 failed: expected 4, got 5 at src/x.ts:41" \
  --drop 12-77ab90c1e2f5
```

`--list` prints the metadata line, the current headers and each block's size — never the bodies,
which are already in your context. `--patch` and `--drop` address blocks by the id in their current
header, refuse a stale draft, refuse to delete an owner turn, and print the resulting shape. Add
`--dry-run` to preview. Hand-rolled `re.sub` over the whole file is how headers get lost; use the
helper, or an `edit` call whose old-text anchor is one whole block.

A tidy pass in place of a summary:

```text
before: [[CTX_TURN ... id=41 role=toolResult ...]]   4,000 lines of test output
after:  [[CTX_TURN ... id=41 role=toolResult ...]]   test suite: 3 passed, T12 failed: expected 4, got 5 at src/x.ts:41
```

Every other block, and block 41's header, stay exactly as they were.

## What to keep

Anything that would cost you work to rediscover: the owner's requirements in their own words, the
current plan, decisions with their reasons, verified facts with the path/command that proved them,
dead ends so you do not retry them, exact values you will use again (ids, paths, numbers, quotes),
unresolved errors in full, and the next action. Keep exact strings you will need verbatim, or
offload them to a file and keep the path plus a one-line index.

If a body carries source text you may need later, call `live_context_annotate` on that block id
first (`pin`, `continuity`, or `archive`), then trim the body. Resolve the annotation once its
future action is done.

## The exception: a full rewrite

A full rewrite means deleting every `[[CTX_TURN ...]]` header and writing free text; it becomes one
notes block after your owner turns. Reach for it only when localized trims cannot free enough room
for the next request, and write the reason into the notes block. It flattens the structure you will
want later — every surviving block becomes a summary, and the next turn imitates that shape. A
draft that still carries headers from an earlier revision is rejected as stale: never leave old
headers behind, and re-read line 1 plus the headers immediately before writing.
