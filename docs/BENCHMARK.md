# Benchmark

What `docs/PLAN.md` section 10 asks for, what was measured, and what was not.

The plan's own rule is worth restating first, because it governs this page:

> **R15** — No evidence that the MCP actually reduces context and turns.
> Mitigation: A/B benchmark from Phase 4 on with the metrics in section 10.
> **Do not publish without numbers.**

So here are the numbers, including the one that does not meet its target.

## Verdict

| Metric | Target | Measured | Met? |
|---|---|---|---|
| Full files read per task | −60% | **−100%** | Yes, by construction |
| Input tokens per task | −50% | **−45%** | **No** |
| Incremental indexing | < 2 s | **0.9 s** | Yes |
| Graph precision vs ground truth | ≥ 95% | **100%** | Yes |
| Turns to first correct edit | −40% | not measured | — |
| Task success rate | ≥ baseline | not measured | — |
| Architecture violations introduced | 0 with `check_rules` | not measured | — |

Reproduce the first three with `pnpm -C packages/server test test/bench`, and
the fourth with `test/integration/ground-truth.test.ts`.

## How context cost was measured

Five tasks, defined in `packages/server/bench/tasks.ts`. Each one pairs:

- **the baseline**: the files whose contents actually hold the answer, measured
  in real bytes;
- **the server route**: the tool calls that answer the same question, measured
  from the real markdown those calls return.

Both sides are exact byte counts of real content. The only estimate is the
bytes-to-token ratio (4), and the byte counts sit beside the token counts so
anyone can redo the arithmetic with a different one.

| Task | Without the server | With it | Context saved |
|---|---|---|---|
| add-pagination | 6 files / 1792 tok | 4 calls / 1250 tok | 30% |
| change-endpoint | 4 files / 799 tok | 3 calls / 464 tok | 42% |
| add-route | 3 files / 419 tok | 2 calls / 300 tok | 28% |
| find-violation | 6 files / 1436 tok | 2 calls / 290 tok | 80% |
| auth-header | 5 files / 914 tok | 3 calls / 617 tok | 32% |
| **Total** | **5359 tok** | **2921 tok** | **45%** |

### Why 45% is not the whole story, in both directions

**The baseline is deliberately unfair to the server.** It assumes a perfect
oracle: an agent that opens exactly the right files, in the right order, with
no grep, no wrong guesses and no re-reads. No real session behaves that way.
Every exploratory read a real agent makes widens the gap.

**And 45% is still short of 50%.** It would be easy to reach the target by
picking tasks that favour the tools — `find-violation` alone scores 80% — or by
counting the baseline more generously. Neither would tell you anything. The
tasks were written before the measurement existed, and the number is what it
is.

The two weakest rows are informative rather than embarrassing:

- **add-route (28%)** — the answer includes a unified diff, which is close in
  size to the code it describes. A mutation's dry run is not where this server
  saves context; its value there is correctness, not compression.
- **add-pagination (30%)** — `angular_get_component` returns a full profile,
  which is genuinely large. It is still smaller than the four files it replaces,
  but not dramatically.

Where the server wins outright is the question that spans files:
`find-violation` needs six files to answer by reading and two calls to answer
by asking, because "which component calls HttpClient" is a property of the
graph, not of any one file.

## What was not measured, and why

Three rows above are blank. They need an agent driven through each task three
times with the server and three times without, with its turns and outcomes
recorded — section 10's actual design. That cannot be derived from the
repository, and simulating it would produce exactly the fabricated evidence
R15 exists to prevent.

To close the gap, someone needs to run the five tasks in
`packages/server/bench/tasks.ts` against a real agent, both ways, and record:

1. turns until the first edit that passes the fixture's tests;
2. whether the task succeeded at all;
3. whether `angular_check_rules` reported a violation on the resulting diff.

Until that exists, the honest position is the one the README states: the
mutations of Phase 5 are built, tested and safe by default, but the evidence
the plan wanted before opening that phase is partial.

## Indexing

Measured on `fixtures/standalone-app`, 20 source files:

| | Time |
|---|---|
| Cold index (`force: true`) | 1.0 s |
| Incremental, nothing changed | 0.9 s |

The incremental run reuses all 20 files from cache and re-extracts none, yet
saves only about 10%. That is not a cache failure: on a project this small
almost all the time goes into building the TypeScript program, which happens
either way. The cache saves extraction, and extraction is not the bottleneck
here. On a real codebase — where extraction dominates and the program is built
once per session — the ratio would look different, and section 10's `< 2 s`
target is about that case. This fixture cannot tell you whether it holds there.
