# Architecture rules (`angular-mcp.rules.yaml`)

The Rules Engine (`packages/server/src/rules/`) lets a repository declare its
own architecture — layers, what each layer may depend on, and explicit
constraints — in a plain YAML file that lives next to the code, not inside the
MCP (see `docs/PLAN.md`, principle P7). The MCP validates it, evaluates it
against the project graph, and exposes it through three tools:
`angular_list_rules`, `angular_check_rules` and `angular_explain_layer`.

This document describes the file format, how it is evaluated, and how it
imports an existing `sheriff` or Nx boundary configuration instead of asking
for a duplicate.

## File location

`angular-mcp.rules.yaml` at the root of the analyzed project (next to
`angular.json` or `package.json`). It is optional: a project with no rules
file — and no `sheriff`/Nx configuration either — simply has no layers,
boundaries or constraints to check, and `angular_check_rules` reports nothing.

## Shape

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

Every top-level key is validated with a Zod schema
(`packages/server/src/rules/schema.ts`); an unknown key, a malformed value, or
a constraint that is neither `forbid` nor `require` is rejected before
anything is evaluated. Validation errors name the offending YAML line — see
[Validation errors](#validation-errors).

### `version`

Required. Must be `1` — the only schema version this engine supports today.

### `layers`

A map from a layer name to `{ match: string[] }`: one or more globs. A file
belongs to the **first** layer (in the order layers are declared) whose glob
matches its path. A file that matches no layer has no layer — it is never
guessed, and no boundary or `forbid`/`require` check involving `from_layer_not`
ever fires for it (see [Unresolved layers](#unresolved-layers-are-never-guessed)).

Supported glob syntax (see `glob.ts`) — deliberately small, matching what a
layer's `match` list actually needs:

| Pattern | Meaning |
|---|---|
| `*` | Anything within a single path segment (no `/`) |
| `**` | Zero or more path segments |
| `?` | A single character |

Paths are always POSIX-style (`/`), relative to the project root.

`layers` may be omitted (or partial) when the project already declares them
through `sheriff` or Nx — see [Importing sheriff/Nx configuration](#importing-sherifffnx-configuration-r10).

### `boundaries`

A map from a layer name to `{ may_depend_on: string[] }`: the layers it is
allowed to depend on. A layer with no entry here may not depend on anything
(a safe default — nothing is permitted that was not declared).

An edge between two different layers that is not listed in `may_depend_on` is
a **boundary violation**. An edge within the same layer is never a boundary
violation, regardless of `may_depend_on` — depending on your own layer is
never a boundary crossing.

Every key here, and every entry in `may_depend_on`, must name a layer that
exists (after merging with any imported layers — see below). An unresolvable
reference is rejected at load time.

#### Which edges count as a boundary

Only edges that represent a real, cross-file structural dependency are
checked (`BOUNDARY_EDGE_KINDS` in `evaluate.ts`):

`imports`, `injects`, `provides`, `uses_in_template`, `routes_to`,
`guarded_by`, `resolves_with`, `extends`.

Notably excluded: `calls_http` (its target is a synthetic `HttpCall` node that
lives in the caller's own file — see `no-http-in-components` below for how to
constrain HTTP calls instead), `declares`, `binds`, `emits`, `renders`,
`returns`, `intercepted_by` (same-file or non-architectural relationships),
and `tested_by`/`child_of` (test wiring and route nesting, not a dependency
between production layers).

#### Unresolved layers are never guessed

If either endpoint of an edge has no resolvable layer, the edge is never
flagged — this follows principle P4 (`docs/PLAN.md`): a fact that cannot be
derived is reported as unknown, never guessed. In practice this means files
outside every `match` glob (a `main.ts`, an external template `.html` file
with no layer of its own, a script) are silently ignored by boundary checks.

### `constraints`

A list of named rules, each **exactly one** of `forbid` or `require`, plus a
`description` (shown in every violation message) and an optional `severity`
(`error` by default, or `warning`).

#### `forbid`

```yaml
forbid: { edge: <EdgeKind>, from?: <NodeKind>, from_layer_not?: <layer> }
```

Matches every edge of kind `edge` whose source node:

- is of kind `from` (when given), and/or
- does **not** belong to layer `from_layer_not` (when given) — an edge from a
  node with no resolvable layer is never matched by `from_layer_not`, for the
  same reason boundaries never guess (above).

At least one of `from`/`from_layer_not` must be given. Both may be given
together (both conditions apply).

#### `require`

```yaml
require: { node: <NodeKind>, attr: <string>, equals: <any> }
```

Flags every node of kind `node` whose `attr` field is not strictly equal to
`equals`. `attr` reads any field on the graph node (see
`packages/server/src/graph/model.ts` for each node kind's shape) —
`changeDetection`, `standalone`, `providedIn`, etc.

#### Suggested allowed path

Every violation may carry a `suggestedPath`: a glob, taken straight from
`layers`, that names a place the offending code IS allowed to live.

- For a `forbid` constraint with `from_layer_not`, the suggestion is always
  the first glob of that required layer (it is the layer the constraint
  names explicitly, so it is always resolvable).
- Otherwise (a boundary violation, or a plain `forbid: { from }`), the engine
  looks for the first layer (in declaration order) whose `boundaries` entry
  allows depending on the violating edge's target layer, and suggests that
  layer's first glob. If no layer is allowed to depend on the target layer,
  there is no suggestion (`suggestedPath` is absent) rather than a guess.

Example: with the file above, a component that calls `HttpClient` directly
produces a `services-own-http` violation with `suggestedPath:
"src/app/**/*.service.ts"` — literally the exit criterion from
`docs/PLAN.md`, section 7: *"A diff that introduces HttpClient into a
component produces a violation with a suggested allowed path."*

### `decisions`

Free-form architecture decisions with an `id`, `text`, and the paths they
`applies_to` (globs). They are schema-validated like everything else, but are
not evaluated by `angular_check_rules` — they are documentation, surfaced by
the Phase 3 `angular_list_decisions` tool (`docs/PLAN.md`, section 6).

## Validation errors

Every problem with the file — a YAML syntax error, a schema violation, or a
cross-source conflict — is reported as a `RulesValidationError`
(`packages/server/src/rules/load.ts`) that names the file and, whenever the
parsed YAML document lets it, the exact line:

```
Invalid rules file "/repo/angular-mcp.rules.yaml":
  - line 4 (layers.ui.match): A layer must declare at least one glob under "match".
```

A missing file (no `angular-mcp.rules.yaml` at all) is not an error by
itself: `loadEffectiveRules` falls back to an empty rules file, so a project
can rely entirely on an imported `sheriff`/Nx configuration (see next
section).

## Importing sheriff/Nx configuration (R10)

If the project already declares its module boundaries with
[`@softarc/sheriff`](https://www.sheriffjs.dev/) (`sheriff.config.ts`) or with
Nx's `@nx/enforce-module-boundaries` ESLint rule plus per-project `tags`, the
MCP imports that configuration instead of asking for a duplicate `layers`/
`boundaries` section — the risk this avoids (`docs/PLAN.md`, R10) is two
sources of truth that quietly drift apart.

`loadEffectiveRules(root, { typescript })` (`load.ts`) is what every tool
actually uses. It:

1. Loads the project's own `angular-mcp.rules.yaml` (or defaults to an empty
   one if it does not exist).
2. Runs both importers (`importers/sheriff.ts`, `importers/nx.ts`) against
   `root`. Each returns `undefined` when its tool is not configured — that is
   the common case, not an error.
3. Merges every layer/boundary, tracking each layer's **origin**
   (`'own' | 'sheriff' | 'nx'`) — this is exactly what `angular_list_rules`
   reports.
4. **Rejects** the merge if the same layer name is declared by more than one
   source (the own file duplicating an imported layer, or `sheriff` and Nx
   both declaring the same tag). This is the one case where duplication is
   flagged as an error rather than silently resolved — R10 says there must
   never be two sources of truth, so it does not pick a winner for you.
5. Re-validates that every `boundaries` key and `may_depend_on`/
   `from_layer_not` reference resolves against the merged layer set.

The project's own `angular-mcp.rules.yaml` is always free to ADD layers,
boundaries and constraints an import does not cover (typically: extra
`constraints` and `decisions` — R10's own words in `docs/PLAN.md`: *"Our own
file only adds the constraints and decisions those tools do not cover"*), it
just cannot redeclare a layer an importer already owns.

### `sheriff.config.ts`

Read (never executed — see [Safety](#safety-configs-are-parsed-never-executed)):

- `tagging`: a nested object mapping folder path segments to one or more
  string tags. Each `(path, tag)` pair becomes a layer named after the tag,
  matching `<path>/**`. A folder tagged with several tags contributes to
  several layers.
- `depRules`: a map from a literal tag name to the tags it may depend on. The
  `sameTag` marker is dropped — a layer may always depend on itself; boundary
  evaluation already never flags a same-layer edge.

Not supported (reported as a warning, never guessed): a wildcard `depRules`
key or target (e.g. `'domain:*'`), or any tagging/depRules value that is not
a string literal, an array of them, or `sameTag` (a function call, a
computed key, a spread, ...).

### Nx (`project.json` tags + `@nx/enforce-module-boundaries`)

Read:

- Every `project.json` under the workspace (bounded search, skipping
  `node_modules`, `dist`, `.git`, `.angular-mcp`, `coverage`): each project's
  `tags` become layers matching `<sourceRoot ?? root>/**`.
- The `@nx/enforce-module-boundaries` ESLint rule's `depConstraints` —
  `{ sourceTag, onlyDependOnLibsWithTags }[]` — read from `.eslintrc.json` or
  a flat `eslint.config.{js,mjs,cjs}`. Each constraint becomes a boundary.

A wildcard `sourceTag` is not supported (warning, skipped — this engine's
`boundaries` map is discrete, not pattern-based). A wildcard
`onlyDependOnLibsWithTags: ['*']` DOES expand — to every tag discovered from
`project.json` — since that is exactly Nx's own meaning ("may depend on
anything").

### Safety: configs are parsed, never executed

`sheriff.config.ts` and an ESLint config both belong to the analyzed
project, not to the MCP, and can contain arbitrary code (R11,
`docs/PLAN.md`). Both importers read them as a TypeScript/JavaScript AST
(`importers/ast-literal.ts`) and convert only their literal, statically
resolvable parts to plain values — nothing in the file is ever `require`d,
`import()`ed, or evaluated.

## Evaluating a diff (`diff.ts`)

`angular_check_rules` is the gatekeeper: an agent calls it with a unified
diff (as `git diff` produces it, with or without the `diff --git` header)
before or after writing a change, and gets back only the violations that diff
introduces — not every pre-existing violation elsewhere in the project.

`parseUnifiedDiff` extracts, per touched file, its status (`added`/
`modified`/`deleted`) and the 1-based line numbers it adds in the new
version. `evaluateDiff(graph, rules, diffText)` then maps every touched file
to its graph nodes and restricts evaluation to:

- boundary/`forbid` checks: only edges with at least one endpoint among the
  touched nodes;
- `require` checks: only nodes that are themselves touched.

This assumes the graph already reflects the diff's content — the project was
(re)indexed after the change was made (principle P1: derive from the code,
never from the diff text itself).

`angular_check_rules` also accepts an explicit `files: string[]` (the same
scoping, without parsing a diff) or nothing at all, in which case the whole
project is checked.

## The three tools (`tools/`)

### `angular_list_rules`

Input: `{ root, limit?, offset?, format? }`.

Returns the effective rules (`loadEffectiveRules`), each layer's origin
(`own`/`sheriff`/`nx`), any importer warnings, and — paginated, per
`limit`/`offset`/`format` like every listing tool (`docs/PLAN.md`, section
6) — which layer every project file resolves to.

### `angular_check_rules`

Input: `{ root, diff?, files?, limit?, offset?, format? }` — `diff` takes
precedence over `files`; with neither, the whole project is checked.

Returns every violation: the rule id, severity, the offending edge or node,
provenance (file/line), and the suggested allowed path when one is
derivable.

### `angular_explain_layer`

Input: `{ root, file }`.

Returns which layer `file` belongs to, the glob that matched, its origin,
and what that layer `may_depend_on` — or, if no layer matches, the list of
declared layers so the caller knows what glob to add.

## Zero false positives

`packages/server/test/rules/fixtures-integration.test.ts` indexes the two
real fixture apps under `fixtures/` (both `standalone-app` and the mixed
NgModule/standalone `ngmodule-app`, R4) with a realistic layered rules file
and asserts that boundary evaluation reports nothing beyond the one
deliberately planted violation in `order-detail.component.ts` — proving both
halves of the Phase 2 exit criterion at once: real violations are detected,
and every legitimate cross-layer edge in real code (lazy routes, guards,
resolvers, a feature module importing a shared module, a feature module
providing a core service, ...) is correctly left alone.
