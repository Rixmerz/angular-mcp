# 3. Index the program's transitive closure, not the tsconfig root names

**Status:** Accepted · **Relates to:** `docs/PLAN.md` §4.1, R14

## Decision

The set of files to index is `program.getSourceFiles()` — the whole transitive
closure — filtered to non-declaration files inside the project and outside
`node_modules`. Every tsconfig a project declares is loaded, not only the first
by target priority.

## Why

The obvious alternative, walking the tsconfig's resolved root names, is wrong
on the layout the Angular CLI actually generates. `angular.json` points the
build target at `tsconfig.app.json`, whose `files` is `["src/main.ts"]` and
whose `include` is `["src/**/*.d.ts"]`. Specs live behind a separate
`tsconfig.spec.json`.

## Evidence

The indexer shipped with the root-names version and **produced an empty graph
on every real Angular project**. Indexing the standalone fixture yielded zero
components.

All 223 indexer tests passed at the time. Every one of them wrote its own
tsconfig, and every one happened to list sources through `include` — a single
blind spot shared by the whole suite. The bug was found by a task that refused
to report success rather than by a test going red.

`test/indexer/real-layout.test.ts` now indexes the fixture through the layout
the CLI generates, which is what the suite was missing.

## Consequences

A file that nothing imports and that no tsconfig lists is still not indexed: it
is not part of any program. That limit is documented at the call site rather
than papered over, because reporting it is cheaper than a heuristic that walks
the filesystem and disagrees with the compiler.

One tsconfig failing to load no longer takes the others down with it (R14).
