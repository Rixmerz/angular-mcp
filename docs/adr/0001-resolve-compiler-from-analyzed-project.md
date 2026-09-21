# 1. Resolve TypeScript and the Angular compiler from the analyzed project

**Status:** Accepted · **Relates to:** `docs/PLAN.md` §4.2, R1

## Decision

`typescript` and `@angular/compiler` are resolved with a `createRequire`
anchored at the analyzed project's root, never from this server's own
`node_modules`.

## Why

The template parser changes between Angular majors. A server that bundles its
own compiler parses an Angular 20 template with Angular 18 rules and reports
the difference as a fact about the user's code. Resolving from the project
means the server always reads a project with that project's own compiler.

The cost is real: the server cannot analyze a project whose dependencies are
not installed, and it fails with an actionable message rather than guessing.

## Evidence

This is not hypothetical. `standalone:` defaulted to `true` in Angular 19;
before that an omitted flag meant `false`. The indexer originally hardcoded
`true` and therefore reported **every** classic NgModule component in the
Angular 18 fixture as standalone — precisely what R4's hybrid resolution turns
on. The fix reads the major version from the project's own compiler
(`standaloneByDefaultFor` in `src/indexer/extractors/decorators.ts`).

A bundled compiler would have made that bug unfixable rather than merely
present.

`fixtures/v20-app` plus `test/integration/version-matrix.test.ts` keep it that
way: they index a real Angular 20 install beside the Angular 18 ones and assert
that the same omitted flag means opposite things in each.

## Consequences

Every extractor takes `typescript` as a parameter instead of importing it, and
none of them import it at module level. `test/indexer/resolve.test.ts` runs in
a real child process with `NODE_PATH` stripped, because vitest's module runtime
falls back to the server's own resolution and would mask the very case under
test.
