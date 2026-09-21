# Angular MCP — Build plan

> Status: initial proposal. This document is the work plan, not a closed specification.
> Every phase has explicit exit criteria; we do not move to the next one without meeting them.

---

## 1. Problem and objective

An agent working on an Angular project spends most of its context and most of its turns
rebuilding, on every task, the same graph of relationships:

```
Component → Template → Signal/Observable → Service → DI → Interceptor → HTTP → Backend
```

On top of that it has to remember repository conventions, routes, contracts, lifecycle and the
associated tests. None of that changes between tasks, yet the agent rediscovers it every time.

**Objective:** build an MCP server that extracts that graph from the code deterministically
and exposes it through semantic tools, so that the agent works with concepts (component,
service, route, contract) instead of files.

**Expected result:** for a typical task ("add pagination to users"), the agent gets the affected
subgraph, the existing similar patterns, the relevant tests and the applicable architecture
rules in one or two calls, instead of reading ten files.

---

## 2. Design principles (non-negotiable)

| # | Principle | Practical consequence |
|---|-----------|------------------------|
| P1 | **Derive, don't remember** | Every structural fact comes out of the code on each query (with a hash-based cache). The agent never "updates the graph" by hand. |
| P2 | **The MCP is deterministic** | It returns facts, subgraphs and matches. It does not recommend implementations; that is the LLM's job. |
| P3 | **Reads before writes** | Query and impact tools come first. Mutations are enabled only once the graph has proven trustworthy. |
| P4 | **Honesty about coverage** | Every fact carries `confidence` and `provenance` (file:line). Whatever cannot be inferred is reported as `unknown`, never guessed. |
| P5 | **Use the compiler, don't reimplement it** | Metadata, DI and template ASTs come from the analyzed project's own `@angular/compiler`. |
| P6 | **Bounded responses** | Every tool that lists supports `limit`, `depth` and `format` (markdown/json). Nothing returns the whole graph. |
| P7 | **Declarative, versioned rules** | The architecture lives in a file in the user's repo, next to the code, not inside the MCP. |

---

## 3. Scope

### In scope (v1)

- **standalone** and **NgModule** Angular projects (both from day one; real projects are mixed).
- Angular CLI workspaces (`angular.json`) with one or several projects.
- Static analysis: components, directives, pipes, services, DI, signals, inputs/outputs,
  template bindings, routes (including lazy ones), guards/resolvers, interceptors,
  HTTP calls, associated specs.
- Declarative architecture rules and checking a diff against them.
- Detection of existing similar patterns (for "do it the way it is already done here").
- **stdio** transport (local use from Claude Code, Cursor, etc.).

### Out of scope (v1)

- Runtime: execution errors, network traffic, logs, live builds. That requires instrumenting
  the process and is a separate project. An extension point is left in place.
- High-level mutations (`add_signal`, `bind_template`). They are only considered in Phase 5, after validating the graph.
- Other frameworks (React, Svelte, Nest). The core design should allow it, but it is not implemented.
- Remote multi-client HTTP transport. Only if a real use case shows up.
- Nx monorepos with `project.json` and no `angular.json`: basic support in v1 (detection), full support in v2.

---

## 4. Architecture

```
                         ┌────────────────────────────┐
                         │         MCP Client         │
                         │  (Claude Code, Cursor...)  │
                         └─────────────┬──────────────┘
                                       │ stdio (JSON-RPC)
                         ┌─────────────▼──────────────┐
                         │      angular-mcp-server    │
                         │  tools · resources · prompts│
                         └─────────────┬──────────────┘
                                       │
          ┌────────────────────────────┼────────────────────────────┐
          ▼                            ▼                            ▼
┌──────────────────┐        ┌──────────────────┐        ┌──────────────────┐
│   Query Engine   │        │   Rules Engine   │        │  Pattern Finder  │
│ find / who_uses  │        │ layers, boundaries│        │ similar_to       │
│ impact / routes  │        │ check diff        │        │ (structural)     │
└────────┬─────────┘        └────────┬─────────┘        └────────┬─────────┘
         │                           │                           │
         └───────────────────────────┼───────────────────────────┘
                                     ▼
                         ┌────────────────────────────┐
                         │        Project Graph       │
                         │  nodes + edges + prov.     │
                         │  (memory + on-disk cache)  │
                         └─────────────┬──────────────┘
                                       │
                         ┌─────────────▼──────────────┐
                         │          Indexer           │
                         │  extractors per concept    │
                         └─────────────┬──────────────┘
                                       │
          ┌────────────────────────────┼────────────────────────────┐
          ▼                            ▼                            ▼
┌──────────────────┐        ┌──────────────────┐        ┌──────────────────┐
│ TypeScript API   │        │ @angular/compiler│        │ Config readers   │
│ (ts.Program)     │        │ parseTemplate    │        │ angular.json,    │
│ decorators, DI,  │        │ template AST     │        │ tsconfig, rules, │
│ inject(), signals│        │ bindings, @if/@for│       │ openapi (opt.)   │
└──────────────────┘        └──────────────────┘        └──────────────────┘
```

### 4.1 Layers

**Indexer.** A set of independent *extractors*, one per concept. Each extractor takes a
`ts.SourceFile` (or a template) and emits nodes and edges with provenance.
They are pure and testable in isolation.

**Project Graph.** A typed in-memory graph with indexes by node type, by name and
by file. It is serialized to `.angular-mcp/cache/` along with each source file's hash.
On startup, only the files whose hash changed are reindexed.

**Query Engine.** Translates the MCP tools into graph traversals. Applies `limit`,
`depth` and the output format.

**Rules Engine.** Loads `angular-mcp.rules.yaml` from the user's repository, validates it
against a schema and evaluates graph edges (or diff edges) against it.

**Pattern Finder.** Given a node, it looks for structurally similar nodes (same shape of
dependencies, same kinds of state, same shape of HTTP call). It does not use embeddings in v1;
it compares structural signatures.

**Server.** A thin layer: registers tools with Zod, annotations and output schemas.
No domain logic.

### 4.2 Key decision: use the analyzed project's compiler

The MCP does **not** bundle its own version of `@angular/compiler`. It resolves
`@angular/compiler` and `typescript` from the analyzed project's `node_modules`.

Reason: the template parser changes between major versions (`@if/@for` control flow,
`@defer`, `@let`, signal inputs). Using a version different from the project's produces
false parse errors or badly resolved bindings.

Consequence: the MCP has to tolerate a range of versions (Angular 17 minimum) and have an
adapter layer per major version. See risk R1.

### 4.3 What we use from the compiler and what we don't

| Need | Source | Stability |
|-----------|--------|-------------|
| Decorators, classes, imports, `inject()`, signals | TypeScript public API (`ts.Program`, type checker) | High |
| Template AST and bindings | `parseTemplate` from `@angular/compiler` | Medium-high (public, changes across major versions) |
| Resolving which component a template tag belongs to | Ours, based on the component's `imports` or the module's `declarations` | High (it's ours) |
| Template type-checking (exact type of each binding) | `NgtscProgram` + `TemplateTypeChecker` | **Low** (semi-internal API used by the Language Service) |

Decision: **v1 does not use `TemplateTypeChecker`**. Binding types are inferred from the
component class via TypeScript. That covers 90% of cases and avoids depending on an
internal API. It will be reassessed in v2 if there is demand for type precision in templates.

---

## 5. Data model

### 5.1 Nodes

Unique identifier: `relative/path/to/file.ts#SymbolName`. Never just the name
(several `UserListComponent` in a monorepo is a real case).

| Type | Main attributes |
|------|------------------------|
| `Component` | selector, standalone, changeDetection, templatePath or inline, stylePaths, inputs[], outputs[], signals[], lifecycleHooks[], hostBindings[] |
| `Directive` | selector, standalone, inputs[], outputs[], hostDirectives[] |
| `Pipe` | name, standalone, pure |
| `Service` | providedIn, isInjectable |
| `NgModule` | declarations[], imports[], exports[], providers[] |
| `Route` | path, componentRef, lazy (loadComponent/loadChildren), guards[], resolvers[], children[], data |
| `Guard` / `Resolver` / `Interceptor` | kind (class or functional) |
| `Template` | path, inline, parseErrors[] |
| `Signal` | ownerRef, name, kind (signal/computed/linkedSignal/input/model/output/viewChild/resource/toSignal), typeText, initialValueText |
| `Observable` | ownerRef, name, typeText (declared fields only; the RxJS flow is not followed in v1) |
| `HttpCall` | method, urlPattern, urlConfidence (literal/template/unknown), requestTypeText, responseTypeText, callerRef |
| `Spec` | path, describes[] (names under `describe(...)`), testedRefs[] |
| `Model` | interfaces/types/classes used as DTOs (heuristic: exported and referenced in an HttpCall or in inputs) |
| `File` | path, hash, lastIndexed |

### 5.2 Edges

Every edge carries `provenance: { file, line, column }` and `confidence: 'certain' | 'inferred' | 'unknown'`.

```
declares          File        → Symbol
injects           Component|Directive|Service|Guard → Service        (constructor or inject())
provides          NgModule|Component|Route → Service
imports           Component|NgModule → Component|Directive|Pipe|NgModule
renders           Component   → Template
uses_in_template  Template    → Component|Directive|Pipe             (by resolved selector)
binds             Template    → Signal|Observable|Method|Property    (name + binding type)
emits             Template    → Output
routes_to         Route       → Component
child_of          Route       → Route
guarded_by        Route       → Guard
resolves_with     Route       → Resolver
calls_http        Service|Component → HttpCall
intercepted_by    HttpCall    → Interceptor                           (if global and detectable)
returns           HttpCall    → Model
tested_by         Symbol      → Spec
extends           Class       → Class
```

### 5.3 Rules file (`angular-mcp.rules.yaml`)

It lives at the root of the user's project. Example:

```yaml
version: 1
layers:
  ui:        { match: ["src/app/**/*.component.ts", "src/app/**/*.directive.ts"] }
  state:     { match: ["src/app/**/*.store.ts", "src/app/**/state/**"] }
  data:      { match: ["src/app/**/*.service.ts", "src/app/**/data/**"] }
  domain:    { match: ["src/app/**/domain/**"] }
  shared:    { match: ["src/app/shared/**"] }

boundaries:
  ui:     { may_depend_on: [state, data, domain, shared] }
  state:  { may_depend_on: [data, domain, shared] }
  data:   { may_depend_on: [domain, shared] }
  domain: { may_depend_on: [shared] }
  shared: { may_depend_on: [] }

constraints:
  - id: no-http-in-components
    description: Components do not make direct HTTP calls.
    forbid: { edge: calls_http, from: Component }
  - id: services-own-http
    description: Only services in the data layer call HttpClient.
    forbid: { edge: calls_http, from_layer_not: data }
  - id: onpush-required
    description: Every component uses OnPush.
    require: { node: Component, attr: changeDetection, equals: OnPush }
    severity: warning

decisions:
  - id: pagination-server-side
    text: Pagination is always done server-side.
    applies_to: ["src/app/**/*-list.component.ts"]
```

If the project already uses `@softarc/sheriff` or `@nx/enforce-module-boundaries`, the MCP
**imports** that configuration instead of demanding a duplicate one (see R10).

---

## 6. MCP tools

The `angular_` prefix keeps them from colliding with other servers. Every read tool has
`readOnlyHint: true`. Every tool that lists accepts `limit` (default 20), `offset` and
`format: 'markdown' | 'json'` (markdown by default). Every response includes `provenance`.

### Phase 1 — Index and query

| Tool | Input | Output | Notes |
|-------------|---------|--------|-------|
| `angular_index_project` | `root?`, `project?`, `force?` | summary: nodes by type, files, time, parse errors | Idempotent. Incremental by hash. |
| `angular_get_index_status` | — | `fresh/stale`, pending files, detected Angular version | Lets the agent know whether it should reindex. |
| `angular_find_symbol` | `query`, `kind?`, `limit?` | candidates with id, kind, path, selector | Search by name, selector or path. Always returns candidates, never a single one. |
| `angular_get_component` | `ref`, `depth?` | full profile: template, state, dependencies, bindings, consumers, routes that load it, reachable HTTP, specs | The central tool. `depth` bounds the reachable-HTTP traversal. |
| `angular_get_service` | `ref` | injected into, injects, HTTP calls, providedIn, specs | |
| `angular_get_route_tree` | `project?`, `path_prefix?`, `depth?` | route tree with lazy loading, guards, resolvers, target component | |
| `angular_who_uses` | `ref`, `via?` (imports/injects/uses_in_template/routes_to) | list of consumers with edge type and provenance | |
| `angular_get_template_bindings` | `ref` | classified bindings: interpolation, property, event, two-way, control flow, with the resolved symbol and its type when known | |
| `angular_list_http_calls` | `filter?` (method, url_pattern, caller) | calls with URL confidence | The basis for the contracts layer. |
| `angular_impact_of` | `refs[]` or `files[]`, `depth?` | affected subgraph upward (consumers) and downward (dependencies), grouped by type, plus the specs reached | The tool for "I'm about to touch X". |

### Phase 2 — Architecture

| Tool | Input | Output |
|-------------|---------|--------|
| `angular_list_rules` | — | loaded rules, origin (own / sheriff / nx), layers resolved per file |
| `angular_check_rules` | `diff?` (unified) or `files[]` or nothing (the whole project) | violations with the rule, the offending edge, provenance and a suggested allowed path |
| `angular_explain_layer` | `file` | which layer it belongs to, why (matching rule), what it may import |

`angular_check_rules` with a diff is the **gatekeeper**: the agent calls it before writing
or after generating the change, and gets concrete violations back.

### Phase 3 — Patterns and contracts

| Tool | Input | Output |
|-------------|---------|--------|
| `angular_find_similar` | `ref`, `aspect?` (dependencies/state/http/template) | nodes with a similar structural signature, ordered by similarity, with a summary of the difference |
| `angular_get_api_contract` | `url_pattern` or `http_call_ref` | if there is an OpenAPI/Swagger file in the repo: the request/response schema. If not: inferred TS types and `confidence: inferred` |
| `angular_list_decisions` | `applies_to?` | decisions declared in the rules file that apply to a path |

### Phase 4 — MCP resources and prompts

- Resource `angular://project/summary`: project summary (counts, version, layers).
- Resource `angular://rules`: the rules file exactly as it was loaded.
- Prompt `angular_plan_change`: a template that guides the agent to call `find_symbol → get_component → impact_of → find_similar → check_rules` before proposing a change. It is the server's only "opinionated" piece and it is optional.

### Phase 5 — Bounded mutations (conditional)

Only if phases 1–3 hit the metrics in section 10. All of them with `dry_run: true`
by default and returning a diff, never writing directly without confirmation.

| Tool | Strategy |
|-------------|------------|
| `angular_generate` | Wraps `ng generate` (the project's own schematics, custom ones included). It adds value because it resolves the path and the options from the detected conventions. |
| `angular_add_route` | Inserts into the right routes array (resolved through the graph), respecting lazy/eager according to the dominant pattern. |
| `angular_add_dependency` | Adds an `inject()` call or a constructor parameter according to the file's dominant style. |

`add_signal` and `bind_template` are **not** in v1. They are the most fragile ones and the ones
that add the least value compared to letting the LLM edit with the context `get_component` already gives it.

---

## 7. Phases, deliverables and exit criteria

Estimates for one person working full time. They are ranges, not commitments.

### Phase 0 — Foundations (1 week)

**Deliverables**
- TypeScript repository: `pnpm`, strict `tsconfig`, ESLint, Vitest, build with `tsup` or `tsc`.
- Server skeleton with `@modelcontextprotocol/sdk` over stdio and an `angular_ping` tool.
- Two fixture apps in `fixtures/`: a modern standalone one (signals, control flow, lazy routes, functional interceptors) and a legacy NgModule one (constructor DI, `RouterModule.forRoot`, `*ngIf`).
- Manual ground truth for both fixtures in `fixtures/*/expected-graph.json`.
- CI: lint, typecheck, tests, and an Angular version matrix (two major versions minimum).

**Exit criterion:** the server starts in MCP Inspector and the CI matrix is green.

### Phase 1 — Indexer and queries (3–4 weeks)

**Deliverables**
- Extractors: `decorators`, `di`, `signals`, `templates`, `routes`, `http`, `specs`, `modules`.
- Project Graph with an on-disk, hash-based cache.
- All the Phase 1 tools, complete.
- Workspace detection (`angular.json`, per-project `tsconfig`).
- Resolution of `@angular/compiler` from the analyzed project's `node_modules`.

**Exit criteria**
- Precision ≥ 95% and recall ≥ 90% on nodes and edges against the ground truth of both fixtures.
- Full indexing of a 500-file app in < 15 s cold and < 2 s incremental.
- No tool response exceeds 8 KB in markdown with the default `limit`.

### Phase 2 — Rules (1–2 weeks)

**Deliverables**
- Schema and validation for the rules file.
- Rules Engine and the three Phase 2 tools.
- Importer for `sheriff` configuration and `nx` boundaries (read, not write).
- Documentation of the rules format with examples.

**Exit criteria**
- `angular_check_rules` detects 100% of the violations planted in the fixtures, with no false positives.
- A diff that introduces `HttpClient` into a component produces a violation with a suggested allowed path.

### Phase 3 — Patterns and contracts (2 weeks)

**Deliverables**
- Pattern Finder based on structural signatures.
- OpenAPI reader (if one exists in the repo) and the `HttpCall → operation` link.
- The Phase 3 tools.

**Exit criterion**
- For "add pagination to users" on the fixture, `find_similar` returns the component that already paginates as the first result.

### Phase 4 — Evaluation and hardening (2 weeks)

**Deliverables**
- 10 evaluation questions (in the format of section 9.3) over the fixtures, with verified answers.
- A/B benchmark of 5 real tasks with and without the MCP (see section 10).
- Optional file watcher (`chokidar`) for hot invalidation.
- Actionable error handling across all tools.
- README with installation instructions for Claude Code and Cursor.

**Exit criterion:** the metrics in section 10 are met. `0.1.0` release.

### Phase 5 — Bounded mutations (conditional, 2–3 weeks)

It only opens if Phase 4 shows that the graph is trustworthy on at least one real project
outside the fixtures. Deliverables per section 6, Phase 5.

---

## 8. Risks and mitigations

| ID | Risk | Prob. | Impact | Mitigation | Warning sign |
|----|--------|-------|---------|------------|-----------------|
| R1 | The `@angular/compiler` API changes between major versions and breaks the template parser. | High | High | Resolve the compiler from the analyzed project. Adapter layer per major version. CI matrix with ≥ 2 versions. Do not use `TemplateTypeChecker` in v1. | Matrix tests fail when a fixture version is bumped. |
| R2 | The graph drifts out of sync with the code (stale cache, files edited outside the MCP). | High | High | Per-file hash on every query. `get_index_status` with `stale`. Optional watcher. Never persist facts that cannot be re-derived. | A query returns a symbol that no longer exists. |
| R3 | Partial coverage of HTTP calls (dynamically built URLs, `environment.apiUrl`, interceptors that rewrite them). | High | Medium | Explicit `urlConfidence`. Resolve simple constants and `environment.*` through limited static evaluation. Report `unknown` for the rest. | More than 30% of HttpCalls marked `unknown` in a real project. |
| R4 | Hybrid NgModule + standalone projects produce incorrect selector resolution in templates. | Medium | High | Both fixtures in place from Phase 0. Per-component scope resolution: its own `imports` or the `declarations` of the module that declares it. | `uses_in_template` with `confidence: unknown` for known selectors. |
| R5 | Large repos (thousands of files, monorepo) make indexing slow or consume too much memory. | Medium | High | Index per `angular.json` project, not the whole workspace. Templates parsed on demand and cached. Time limits and pagination. Consider SQLite if > 5k files. | Cold indexing > 60 s. |
| R6 | Responses that are too large flood the agent's context, recreating the very problem we set out to solve. | High | High | `limit`, `depth` and `format` everywhere. Summarized markdown profiles by default, full JSON only on request. 8 KB cap by default. | The agent repeatedly asks for high `limit` values or truncates. |
| R7 | The agent trusts the graph without verifying and acts on a wrong inferred fact. | Medium | High | `confidence` and `provenance` on every fact. Tool descriptions that state explicitly what is inferred. Never omit the file:line. | Benchmark tasks fail because of an incorrect `inferred` fact. |
| R8 | Mutations generate code that violates the repository's conventions. | High | Medium | Mutations deferred to Phase 5 and gated on metrics. Delegate to the project's own schematics. `dry_run` by default. Detect the dominant style before writing. | Any mutation that has to be fixed by hand in the benchmark. |
| R9 | The MCP takes on reasoning (recommendations, priorities) and turns into an LLM inside an LLM: non-deterministic, hard to test. | Medium | Medium | P2. Review each tool: if the output is not reproducible from the graph, it does not go in. The only "opinionated" element is the optional prompt. | A tool appears whose output cannot be tested with exact equality. |
| R10 | Duplicated rules with `sheriff`, `eslint-plugin-boundaries` or Nx: two sources of truth that diverge. | Medium | Medium | Importer for those configurations. Our own file only adds the `constraints` and `decisions` those tools do not cover. | A user maintains two layer files. |
| R11 | Security: path traversal in `root`/`files`, command execution when wrapping `ng generate` or tests. | Low | High | Validate that every path resolves inside the root. No shell: `spawn` with arguments as an array. Timeouts. No network access. | A security test fails. |
| R12 | Scope creep toward runtime, other frameworks or early mutations. | High | Medium | Per-phase gates with exit criteria. Section 3 as the reference in every review. | A PR adds a tool that is not listed in section 6. |
| R13 | Name ambiguity (several symbols with the same name in a monorepo). | Medium | Medium | Ids = `path#symbol`. `find_symbol` always returns candidates. The other tools require the full `ref`. | The agent calls `get_component` with a bare name and gets the wrong one. |
| R14 | Inline template vs file, templates with syntax errors, badly resolved relative `templateUrl`. | Medium | Low | Store `parseErrors` on the `Template` node and expose them. Do not abort the index because of one broken template. | The index aborts because of a single file. |
| R15 | No evidence that the MCP actually reduces context and turns. | Medium | High | A/B benchmark from Phase 4 on with the metrics in section 10. Do not publish without numbers. | There is no benchmark when Phase 4 closes. |
| R16 | Dependence on `NgtscProgram` to resolve standalone import scope in complex cases (re-exports, `forwardRef`, barrels). | Medium | Medium | Our own resolution via the TS type checker for imports and barrels. Unresolved cases marked `unknown`. Reassess `NgtscProgram` in v2 for those cases only. | A fixture with barrels shows `imports` marked `unknown`. |

---

## 9. Testing strategy

### 9.1 Unit tests (per extractor)

Each extractor is tested against minimal code fragments: a `ts.SourceFile` in,
the expected nodes/edges out. Cover:

- DI via constructor, via `inject()`, with `@Optional`, `@Inject(TOKEN)`, `inject(TOKEN, { optional: true })`.
- Signals: `signal`, `computed`, `linkedSignal`, `input`, `input.required`, `model`, `output`, `viewChild`, `toSignal`, `resource`, `httpResource`.
- Templates: interpolation, `[prop]`, `(event)`, `[(ngModel)]`, `@if/@for/@switch/@defer/@let`, `*ngIf/*ngFor`, pipes, `#ref` references.
- Routes: literal array, `provideRouter`, `RouterModule.forRoot/forChild`, `loadChildren` with `import()`, `loadComponent`, `children`, functional and class guards.
- HTTP: `HttpClient.get/post/put/patch/delete`, generics, literal URL, template literal, concatenation, `environment.apiUrl`.

### 9.2 Integration tests (per fixture)

The full index of each fixture compared against `expected-graph.json` through structural
equality (ignoring order). Any divergence is a failure, not a warning.

### 9.3 Agent evaluation

Ten questions in the MCP evaluation format (`evaluation.xml`), independent,
read-only, each with a single verifiable answer. Examples:

- "Which component does the `/admin/users` route load, and which guard protects it?"
- "Which services does `OrderDetailComponent` transitively inject on the way to an HTTP call?"
- "Which is the only component that makes a direct HTTP call, violating the `no-http-in-components` rule?"

### 9.4 Version matrix

CI runs the fixtures against at least two major Angular versions installed in
`fixtures/*/node_modules`. When a new major Angular version ships, it is added to
the matrix before any other work.

---

## 10. Success metrics (Phase 4)

Benchmark: five real tasks on an extended fixture, run by the same agent
with and without the MCP, three repetitions each.

| Metric | Target |
|---------|----------|
| Input tokens consumed per task | −50% with MCP |
| Full files read per task | −60% with MCP |
| Turns until the first correct edit | −40% with MCP |
| Task success rate (tests pass) | ≥ the same as without MCP; never lower |
| Architecture violations introduced | 0 with `check_rules` in the loop |
| Graph precision vs ground truth | ≥ 95% |
| Incremental indexing | < 2 s |

If the success rate drops with the MCP, Phase 5 is halted and R7 is investigated.

---

## 11. Tech stack

| Area | Choice | Reason |
|------|----------|--------|
| Language | TypeScript, ESM, Node ≥ 20 | Same ecosystem as Angular; first-class MCP SDK. |
| MCP | `@modelcontextprotocol/sdk` | Official. `registerTool` with Zod, `outputSchema`, annotations. |
| TS parsing | The `typescript` API (from the analyzed project) | No extra dependencies; `ts-morph` only if it substantially simplifies Phase 5. |
| Template parsing | `@angular/compiler` (from the analyzed project) | See 4.2. |
| Validation | Zod | Input schemas, output schemas and the rules file schema. |
| Rules | YAML + Zod schema | Readable in code review. |
| Cache | One JSON file per source file under `.angular-mcp/cache/` | Simple, inspectable, no native dependencies. SQLite is evaluated in R5. |
| Watcher | `chokidar` (optional) | Hot invalidation. |
| Tests | Vitest | Fast, native ESM. |
| Build | `tsup` | A single `angular-mcp` binary runnable with `npx`. |
| Package manager | `pnpm` | Workspace for `packages/server` and `fixtures/*`. |
| CI | GitHub Actions | Angular version matrix. |

Logs always go to `stderr` (stdio reserves `stdout` for the protocol).

---

## 12. Proposed repository structure

```
angular-mcp/
├── docs/
│   ├── PLAN.md                 ← this document
│   ├── RULES.md                ← rules file format
│   └── adr/                    ← architecture decisions (one per file)
├── packages/
│   └── server/
│       ├── src/
│       │   ├── index.ts        ← stdio entry point
│       │   ├── server.ts       ← tools/resources/prompts registration
│       │   ├── tools/          ← one tool per file
│       │   ├── indexer/
│       │   │   ├── workspace.ts
│       │   │   ├── program.ts  ← loads ts.Program and the project's compiler
│       │   │   └── extractors/
│       │   ├── graph/          ← model, indexes, cache
│       │   ├── rules/          ← schema, loading, evaluation, importers
│       │   ├── patterns/       ← structural signatures and similarity
│       │   └── format/         ← markdown/json, truncation, pagination
│       └── test/
├── fixtures/
│   ├── standalone-app/
│   │   └── expected-graph.json
│   └── ngmodule-app/
│       └── expected-graph.json
├── evals/
│   └── evaluation.xml
└── .github/workflows/ci.yml
```

---

## 13. Open decisions

| Decision | Options | When it gets decided |
|----------|----------|------------------|
| ~~Graph persistence~~ | ~~One JSON file per source file vs SQLite~~ | **Decided: JSON kept.** See [ADR 4](adr/0004-graph-persistence.md) — the benchmark shows extraction is not the bottleneck, so the store is not where the time goes. |
| Nx support without `angular.json` | Basic in v1 vs full in v2 | Based on demand after 0.1.0. |
| Following the RxJS flow (`pipe`, `switchMap`) to connect observables with HTTP | Not in v1; possible in v2 | If the benchmark shows the agent needs it. |
| `TemplateTypeChecker` for exact types in templates | Excluded in v1 | v2, only if R16 materializes. |
| npm package name | `angular-mcp-server` vs `@rixmerz/angular-mcp` | Before publishing 0.1.0. |
| License | MIT vs Apache-2.0 | Before publishing 0.1.0. |

---

## 14. Future extensibility (not committed)

- **Runtime:** a second server, or an optional mode, that consumes `ng serve` errors,
  test results and browser HTTP traffic, and links them to graph nodes.
- **Other frameworks:** the Project Graph, the Rules Engine and the Pattern Finder are agnostic.
  Only the extractors are Angular-specific. A `react-mcp` would reuse 60% of the core.
- **Live contracts:** linking `HttpCall` to the real backend (Nest, Spring) when both
  repos are available in the same workspace.

---

## 15. Executive summary

1. Extract the Angular graph from the compiler, don't reinvent it.
2. Always derive; never remember. Hash-based cache, never editable memory.
3. Queries and impact first; mutations only after proving reliability with numbers.
4. Every fact with confidence and provenance; the unknown is declared unknown.
5. Declarative architecture rules in the user's repo, importing the ones that already exist.
6. Five phases with measurable exit criteria; Phase 5 is conditional.
