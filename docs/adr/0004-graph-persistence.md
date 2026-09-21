# 4. Keep the JSON cache; do not adopt SQLite

**Status:** Accepted · **Relates to:** `docs/PLAN.md` §11, §13, R5

## Decision

The graph stays cached as JSON, keyed by file hash. SQLite is not adopted.

`docs/PLAN.md` §13 listed this as open, to be settled "at the end of Phase 1,
with real performance data". The benchmark now provides that data.

## The data

On `fixtures/standalone-app`, 20 source files
(`packages/server/test/bench/`, reported in `docs/BENCHMARK.md`):

| | Time |
|---|---|
| Cold index (`force: true`) | ~1.0 s |
| Incremental, nothing changed | ~0.6–0.9 s |

The incremental run reuses all 20 files and re-extracts none, yet saves only
about 10%.

## What that says

The cache is doing its job — the deterministic assertion is that
`filesReindexed` is zero and `filesReused` equals `filesProcessed`. The 10%
is not a cache failure; it means **extraction is not the bottleneck**.
Building the `ts.Program` is, and that happens either way, whatever the cache
is made of.

Swapping JSON for SQLite would make the part that already costs almost nothing
cost slightly less. It would add a native dependency, a schema to migrate, and
a store you cannot read with `cat` — against R5's actual concern, which is
memory and time on repositories with thousands of files.

## Honest limit

This fixture has 20 files. It cannot tell you where the crossover is. The
decision is "not on this evidence", not "never".

Revisit when a real project shows cold indexing above the 60 s R5 names as its
warning sign, or when memory rather than time becomes the constraint. The
measurement to take first is the split between program construction and
extraction: if extraction has become dominant, the store is worth revisiting;
if it has not, SQLite will not help.
