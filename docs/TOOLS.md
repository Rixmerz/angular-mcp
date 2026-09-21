# Tool catalogue

Nineteen tools. Sixteen are read-only; the three mutations at the end are the
only ones that can write, and each defaults to a dry run. Every tool takes an
optional `root` (defaulting to the workspace the server was started against),
and every one that returns a list takes `limit`, `offset` and `format`.

Every example below is real output from `fixtures/standalone-app`, captured over
stdio. Nothing here is illustrative-only.

## Conventions

**Refs.** A symbol is addressed by `path#Name`, for example
`src/app/core/services/user.service.ts#UserService`. A bare name works when it
matches exactly one symbol; when it matches several, the tool refuses to pick
one and returns the candidates instead (docs/PLAN.md R13). Start from
`angular_find_symbol` when you only know part of a name.

**Confidence.** Every fact carries one:

| Value | Meaning |
|---|---|
| `certain` | Read straight from the AST. A literal URL, a local class, a decorator property. |
| `inferred` | Derived through a heuristic that was not checked against disk — typically resolving an import specifier to a file path. |
| `unknown` | Could not be determined. The original source text is reported instead of a guess. |

**Formats.** `format: "markdown"` (the default) is summarized and capped at 8 KB,
declaring the truncation. `format: "json"` returns the full structured data.
Every list reports `total_count`, `has_more` and `next_offset`.

---

## angular_index_project

Builds or refreshes the project graph. Incremental by file hash: only changed
files are re-extracted unless `force` is set. Call it once before anything else.

| Input | Type | Notes |
|---|---|---|
| `root` | string? | Workspace to index. |
| `force` | boolean? | Re-extract every file, ignoring the cache. |

Returns the workspace kind, the Angular and TypeScript versions **resolved from
the analyzed project** (not from the server), node counts by kind, and any files
it could not read or templates it could not parse.

```json
{
  "root": "/path/to/standalone-app",
  "workspaceKind": "angular-cli",
  "angularVersion": "18.2.14",
  "typescriptVersion": "5.5.4",
  "cacheDir": ".angular-mcp/cache"
}
```

## angular_get_index_status

Whether the graph is fresh or stale relative to disk, without rebuilding it.
Worth calling before trusting the other tools if files may have changed outside
the session.

## angular_find_symbol

Search by name, selector or path substring. **Always** returns a list and never
resolves to a single best match — this is the only tool allowed to be uncertain
about which symbol you mean.

| Input | Type | Notes |
|---|---|---|
| `query` | string | Matched case-insensitively against name, selector and path. |
| `kind` | enum? | Restrict to `Component`, `Service`, `Route`, … |

```
## Symbols matching "OrderList"

- **Template** `src/app/features/orders/order-list/order-list.component.html#OrderListComponent.template`
- **Component** `src/app/features/orders/order-list/order-list.component.ts#OrderListComponent` <app-order-list>

_Showing 1-2 of 2._
```

## angular_get_component

Everything about one component: inputs, outputs, signals, lifecycle hooks, host
bindings, injected dependencies, imports, who renders it, which routes load it,
reachable HTTP calls, and its specs.

```
## Component profile: .../order-list.component.ts#OrderListComponent

- **Input** pageSize: number (required)
- **Input** currentPage: unknown type _(unknown)_
- **Output** currentPage: unknown type _(unknown)_
- **Signal** pageSize: input <number> (required)
- **Signal** currentPage: model
- **Signal** paginatorEl: viewChild <ElementRef<HTMLDivElement>>
- **Signal** status: signal <LoadStatus>
- **Signal** totalPages: computed
- **Dependency** injects OrderService via inject — `order-list.component.ts:26:35` _(inferred)_
```

`currentPage` appears as both an input and an output because `model()` is both.
Its type reads `unknown` because it is inferred from the initial value rather
than written down — reported as unknown rather than guessed.

## angular_get_service

Where a service is provided, who injects it, what it injects, the HTTP calls it
makes, and its specs.

## angular_get_route_tree

The routing configuration flattened: full path, target component, lazy-loading
kind, guards and resolvers.

```
## Route tree

- **Route** / → (no component), guards: authGuard — `orders.routes.ts`
- **Route** /orders [lazy:loadChildren] → (no component) _(inferred)_
- **Route** /users [lazy:loadComponent] → UserListComponent _(inferred)_
- **Route** /:id [lazy:loadComponent] → OrderDetailComponent, resolvers: orderResolver _(inferred)_
```

Lazy targets are `inferred`: the import specifier is resolved to a file path by
joining it, never by checking disk.

## angular_who_uses

One hop: components and modules that import a symbol, classes that inject it,
templates that use it, routes that route to it. Use `angular_impact_of` when you
need the transitive answer.

## angular_get_template_bindings

A template's bindings classified as interpolation, property, event, two-way,
control-flow or attribute, each resolved to the element, directive or pipe it
targets, and to the declared signal behind the member when there is one.

## angular_list_http_calls

Every `HttpClient` call, with method, URL pattern, the confidence in that
pattern, request and response types, and the caller.

```
## HTTP calls

- **HttpCall** GET https://api.example.com/users (from UserService)
- **HttpCall** POST ${environment.apiUrl}/orders (from OrderService) _(inferred)_
- **HttpCall** GET url (from OrderService) _(unknown)_
- **HttpCall** GET `${environment.apiUrl}/users/${id}` (from UserService) _(unknown)_
```

These four rows show the ladder (docs/PLAN.md R3). A literal URL is `certain`,
and carries no suffix. A template literal the extractor can piece together is
`inferred`. A URL assembled through a local variable is `unknown`, and the
variable's own name (`url`) is reported rather than a fabricated URL — as is a
template literal whose pieces could not all be resolved.

## angular_impact_of

"I am about to change X": consumers upward, dependencies downward, both bounded
by `depth` (default 3, max 10), plus the specs that cover what you touch.

| Input | Type | Notes |
|---|---|---|
| `refs` | string[]? | Symbols about to change. |
| `files` | string[]? | Files about to change; every symbol in each is a starting point. |
| `depth` | number? | Hops in each direction. |

```
## Impact of

- **Service** [target] UserService
- **HttpCall** [dependency @1] getUsers.get
- **Interceptor** [dependency @2] authInterceptor
- **Component** [consumer @1] UserListComponent
- **Route** [consumer @2] users
- **Spec** [spec @0] Spec (src/app/core/services/user.service.spec.ts)
- **Spec** [spec @0] Spec (src/app/features/users/user-list/user-list.component.spec.ts)
```

This is the chain the server exists for: from a service, down through its HTTP
calls to the interceptor that sees them, and up through the component that
injects it to the route that loads it — with the two specs you would need to
update.

## angular_list_rules

The architecture rules in effect: layers and their globs, allowed dependencies,
named constraints, and where each layer came from — the project's own rules file,
an imported [sheriff](https://softarc-consulting.github.io/sheriff/) config, or
Nx tags.

## angular_check_rules

Evaluates the rules against a unified diff, a list of files, or the whole
project. Every violation names the rule, the offending file and line, and — when
the rules make one derivable — a path that would be allowed instead.

| Input | Type | Notes |
|---|---|---|
| `diff` | string? | A unified diff, as `git diff` produces. Takes precedence over `files`. |
| `files` | string[]? | Paths to restrict the check to. |

Against the standalone fixture, which carries one deliberately planted
violation in `order-detail.component.ts`:

```
[error] src/app/features/orders/order-detail/order-detail.component.ts:28:
Components do not make direct HTTP calls. (constraint "no-http-in-components":
forbidden "calls_http" edge from
"src/app/features/orders/order-detail/order-detail.component.ts#OrderDetailComponent").
```

Each violation also carries the offending edge and, when the rules name a layer
that *is* allowed to hold the dependency, a `suggestedPath` glob pointing at it.

## angular_explain_layer

Which layer a file belongs to, which glob matched it, where that layer was
defined, and what it may depend on. Use it when `angular_check_rules` reports
something and you need to know why that file is in that layer. A file no glob
matches is reported as having no layer, not assigned to a default one.

## angular_find_similar

Symbols whose *structure* resembles a given one — what they inject, which
reactive primitives they declare, which HTTP methods they reach (directly or
through one hop of injection), and what their template is made of. Use it to
find the pattern the codebase already uses before inventing a new one.

| Input | Type | Notes |
|---|---|---|
| `ref` | string | The symbol to find analogues of. |
| `aspect` | string[]? | Which facets to compare: `dependencies`, `state`, `http`, `template`. Defaults to all four. |
| `min_score` | number? | Drop candidates below this overlap. |

Member names are deliberately excluded from the comparison: two paginated lists
are the same shape whether they call it `pageSize` or `perPage`. The injected
symbol's *name* is kept alongside its kind, so a same-service match outranks a
same-shape one and both questions stay answerable.

The score is a counted overlap of structural tokens and the summary states how
each candidate differs, in both directions. It ranks; it does not recommend.
Ties break on ref, so repeated runs agree.

## angular_get_api_contract

The request and response shape of an endpoint the project calls.

| `source` | Meaning |
|---|---|
| `openapi` | Read from an OpenAPI or Swagger document in the repository. This is the backend's stated contract, and is marked `certain`. |
| `typescript-generics` | Read from the call site's type arguments. This is what the frontend *assumes*, and is marked `inferred`. |

The distinction is the point: an agent that cannot tell a contract from an
assumption writes code against the assumption. A URL the extractor could not
resolve statically is never matched against a path — guessing which endpoint an
unresolved URL meant is exactly what `unknown` exists to prevent. Nothing is
fetched over the network.

## angular_list_decisions

The architecture decisions the project declares in its rules file, optionally
filtered to the ones that apply to one path. A decision is prose a team wrote
down, not a machine-checkable constraint, so it is reported verbatim and never
interpreted. A decision with no `applies_to` is project-wide.

---

# Mutations

The three tools below can write. All of them share one rule, from the plan:

> **`dry_run` defaults to `true`.** The change is computed and returned as a
> unified diff, and nothing is written. Pass `dry_run: false` only after
> reviewing that diff — ideally after running `angular_check_rules` over it.

Their annotations say so: `readOnlyHint: false`, because the tool *can* write,
even though its default does not.

## angular_generate

Runs the analyzed project's **own** Angular CLI, so the generated code follows
that project's schematics — custom ones included — and its `angular.json`
defaults, rather than something this server invented.

| Input | Type | Notes |
|---|---|---|
| `schematic` | enum | `component`, `directive`, `pipe`, `service`, `guard`, `interceptor`, `resolver`, `module`, `class`, `interface`, `enum`. |
| `name` | string | Name with optional path, e.g. `features/users/user-card`. |
| `options` | {flag, value}[]? | Each already split, so neither can smuggle the other. |
| `dry_run` | boolean? | Defaults to true. |

```
angular_generate { schematic: "component", name: "features/reports/report-list" }

dryRun: true | exit: 0
CREATE src/app/features/reports/report-list/report-list.component.ts
CREATE src/app/features/reports/report-list/report-list.component.html
CREATE src/app/features/reports/report-list/report-list.component.css
CREATE src/app/features/reports/report-list/report-list.component.spec.ts
```

The CLI is located inside the project and spawned with its arguments as an
array — never through a shell, so a component name can never become a command —
and every run is bounded by a timeout. A name that could be read as a flag or as
shell syntax is refused by name:

```
angular_generate { schematic: "component", name: "a; rm -rf /" }
→ Invalid name "a; rm -rf /". Use letters, digits, dots, dashes, underscores and slashes.
```

A dry run passes the CLI's own `--dry-run`, so nothing reaches disk because the
CLI itself did not write it.

## angular_add_route

Adds a route to a routing array, written the way that array already writes its
routes. Use `angular_get_route_tree` first to find the file and array you mean.

| Input | Type | Notes |
|---|---|---|
| `file`, `array_name` | string | Where the routes live, e.g. `src/app/app.routes.ts` and `routes`. |
| `path`, `component`, `component_path` | string | The new entry. |
| `loading` | enum? | Override the array's dominant style. Omit to follow the neighbours. |

```
angular_add_route {
  file: "src/app/app.routes.ts", array_name: "routes", path: "reports",
  component: "ReportListComponent", component_path: "./features/reports/report-list.component"
}

dryRun: true | loading: loadComponent | why: 2 of 2 routes load lazily

--- a/src/app/app.routes.ts
+++ b/src/app/app.routes.ts
@@ -11,5 +11,10 @@
     loadChildren: () => import('./features/orders/orders.routes').then((m) => m.ORDERS_ROUTES),
   },
+  {
+    path: 'reports',
+    loadComponent: () =>
+      import('./features/reports/report-list.component').then((m) => m.ReportListComponent),
+  },
 ];
```

The entry is **appended**, never inserted higher up: Angular matches routes in
order, and silently moving someone's catch-all is not a bounded mutation. An
empty or evenly split array reports `loadingConfidence: "unknown"` — a default
was used, not a pattern detected.

## angular_add_dependency

Injects a dependency into a class, in whichever style that file already uses,
adding the import when one is needed.

| Input | Type | Notes |
|---|---|---|
| `ref` | string | The class to inject into. |
| `dependency` | string | Type to inject, e.g. `OrderService`. |
| `property_name` | string? | Defaults to the type name, lower-camel-cased. |
| `import_from` | string? | Module specifier, when the file does not import it yet. |

```
angular_add_dependency { ref: "UserListComponent", dependency: "OrderService",
                         import_from: "../../../core/services/order.service" }

style: inject | confidence: certain
why: the class already uses inject() (1 inject call(s), 0 constructor parameter(s))

+import { OrderService } from '../../../core/services/order.service';
...
 export class UserListComponent {
+  private readonly orderService = inject(OrderService);
+
   private readonly userService = inject(UserService);
```

The style is read from the class itself (`certain`), falling back to the
project's dominant style (`inferred`) and then to `inject()` (`unknown`) — and
which of the three happened is always reported. Writing `inject()` into a
codebase of constructor parameters is the hand-fixing this phase is built to
avoid.

Edits are text splices, not re-printed ASTs, so the diff shows the line that
changed rather than a reformatted file.

---

## Resources and prompt

| URI | Contents |
|---|---|
| `angular://project/summary` | Counts, versions, workspace layout, and index coverage — including how many files could not be read and how many templates failed to parse. A project that was never indexed reports `indexed: false` rather than looking empty. |
| `angular://rules` | The effective rules exactly as loaded, with each layer's origin. |

The `angular_plan_change` prompt walks through the call order worth following
before proposing a change: `find_symbol` → `get_component` → `impact_of` → find a
pattern already in the codebase → `check_rules`. It is the only opinionated piece
in the server, and it is optional.
