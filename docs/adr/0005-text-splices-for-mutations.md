# 5. Edit source with text splices, not by re-printing the AST

**Status:** Accepted · **Relates to:** `docs/PLAN.md` §6 Phase 5, R8

## Decision

The Phase 5 mutations compute their edit as a text splice over the original
source. The TypeScript printer is not used to re-emit the file.

## Why

The printer reformats everything it touches: quotes, trailing commas, line
breaks, member order. A one-line change comes back as a whole-file diff.

Phase 5's entire safety model is `dry_run: true` returning a diff for a human
or an agent to read before anything is written. A diff nobody can review is the
same as no diff, so the mutation would keep its ceremony and lose its point.

Splices also preserve the file's own conventions for free, which is what R8
asks for: the code around the edit is untouched because it was never rewritten.

## What it costs

Correctness is on us. The printer would never emit a syntactically invalid
file; a splice can.

It did. Appending to a routes array whose last element already carried a
trailing comma consumed that comma and emitted `}` straight before `{` — a
file that does not parse. The unit tests missed it because they assert on
substrings, and a file with a dropped separator still contains every substring
you looked for.

## Consequence

Any mutation must be covered by a test that **parses** its output, not merely
one that greps it. `test/mutations/mutations.test.ts` does this across four
array shapes and five class shapes, and first asserts that the parser really
does reject a broken file, so the check itself is worth something.

Adding a mutation without that parse test reopens exactly this bug.
