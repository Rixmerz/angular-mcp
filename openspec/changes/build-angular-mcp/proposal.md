# Build the Angular MCP server

## Why

An agent working on an Angular project rebuilds the same relationship graph on
every task: component, template, signal, service, dependency injection,
interceptor, HTTP, backend. That graph already exists explicitly in the Angular
compiler and in the TypeScript AST, but there is no way to query it. The agent
rediscovers it by reading files, which burns context and turns on work that does
not change between tasks.

## What Changes

This change builds phases 0, 1 and 2 of `docs/PLAN.md`:

- Monorepo scaffolding and continuous integration.
- Two Angular test fixtures, one standalone and one NgModule, with their
  expected graph written by hand.
- An indexer with one extractor per concept, built on the TypeScript API and on
  the template parser resolved from the analyzed project.
- The project graph, with a cache invalidated by file hash.
- Ten MCP query and impact tools.
- A declarative architecture rules engine and diff verification.
- The server wired over stdio, with resources and a prompt.

Deliberately out of scope, per the plan: runtime analysis, high-level mutations
and other frameworks.

## Impact

- New repository. There is no existing code to break.
- `packages/server` becomes the publishable package.
- `fixtures/` becomes the basis for measuring graph accuracy.
