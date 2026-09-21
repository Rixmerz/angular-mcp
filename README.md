# angular-mcp

An MCP server that exposes the semantic graph of an Angular project — components,
dependency injection, signals, templates, routes, HTTP calls, interceptors and
specs — as query tools, so an agent does not have to rediscover it file by file
on every task.

## The problem

Ask an agent to add pagination to a list component and it starts from nothing:
grep for the component, open it, open its template, guess which service it uses,
open that, look for the HTTP call, wonder whether an interceptor rewrites the
URL, hunt for a component that already paginates, and hope it noticed the spec.
Every one of those steps burns context, and the answer is thrown away when the
session ends.

The relationships are not ambiguous — the compiler knows them exactly. This
server derives them and answers questions about them directly:

```
angular_impact_of { refs: ["UserService"], depth: 2 }

- **Service**     [target]         UserService
- **HttpCall**    [dependency @1]  getUsers.get
- **Interceptor** [dependency @2]  authInterceptor
- **Component**   [consumer @1]    UserListComponent
- **Route**       [consumer @2]    users
- **Spec**        [spec @0]        user.service.spec.ts
- **Spec**        [spec @0]        user-list.component.spec.ts
```

One call, instead of a dozen file reads — and it names the two specs you would
otherwise have found out about from CI.

## What it does not do

It reports facts, never judgement. Every fact carries where it came from and how
sure the server is of it: `certain` when it was read from the AST, `inferred`
when a heuristic derived it, `unknown` when it could not be determined. A URL
built at runtime comes back as `unknown` with the original expression, not as a
plausible-looking guess.

Sixteen of the nineteen tools are read-only. The three that can write —
`angular_generate`, `angular_add_route` and `angular_add_dependency` — all
default to a dry run that returns a unified diff and touches nothing, and each
follows the conventions your code already uses rather than imposing its own.

## Install

Requires Node 20 or newer. The server reads the analyzed project's **own**
`typescript` and `@angular/compiler`, so it follows whatever Angular version that
project is on rather than pinning one.

```bash
pnpm install
pnpm -C packages/server build
```

### Claude Code

```bash
claude mcp add angular -- node /absolute/path/to/angular-mcp/packages/server/dist/index.js /absolute/path/to/your-angular-app
```

Or in `.mcp.json`, to share it with a team:

```json
{
  "mcpServers": {
    "angular": {
      "command": "node",
      "args": [
        "/absolute/path/to/angular-mcp/packages/server/dist/index.js",
        "/absolute/path/to/your-angular-app"
      ]
    }
  }
}
```

### Cursor

In `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "angular": {
      "command": "node",
      "args": [
        "/absolute/path/to/angular-mcp/packages/server/dist/index.js"
      ],
      "env": {
        "ANGULAR_MCP_ROOT": "/absolute/path/to/your-angular-app"
      }
    }
  }
}
```

The workspace comes from the first argument, then `ANGULAR_MCP_ROOT`, then the
working directory. It is fixed when the server starts, and every path a tool
receives is validated to resolve inside it.

## A session

```
> Add server-side pagination to the user list.

  angular_index_project {}
    → angular-cli workspace, Angular 18.2.14, TypeScript 5.5.4

  angular_find_symbol { query: "UserList" }
    → src/app/features/users/user-list/user-list.component.ts#UserListComponent

  angular_get_component { ref: "UserListComponent" }
    → input pageTitle, output userSelected, signals searchTerm/users/filteredUsers,
      injects UserService, template user-list.component.html

  angular_find_symbol { query: "pageSize" }
    → Signal order-list.component.ts#OrderListComponent.pageSize
      (so OrderListComponent already solves this; angular_get_component on it
       shows input.required<number> pageSize, model currentPage, computed totalPages)

  angular_impact_of { refs: ["UserService"], depth: 2 }
    → UserListComponent consumes it; the users route loads that; two specs cover it

  angular_check_rules { files: ["src/app/features/users/user-list/user-list.component.ts"] }
    → no violations

  angular_add_dependency { ref: "UserListComponent", dependency: "OrderService" }
    → dry run: a diff adding `private readonly orderService = inject(OrderService);`
      inject(), not a constructor parameter, because that is what the class already uses
```

The agent now knows the pattern the codebase already uses for pagination, what
it will break, and which specs to update — before writing a line.

## Architecture rules

Rules live in your repository as a versioned file, so they are reviewed like
code. If you already declare boundaries with
[sheriff](https://softarc-consulting.github.io/sheriff/) or Nx tags, those are
imported rather than duplicated.

```yaml
version: 1
layers:
  ui:   { match: ['src/app/**/*.component.ts'] }
  core: { match: ['src/app/core/**'] }
boundaries:
  ui:   { may_depend_on: [core] }
  core: { may_depend_on: [] }
constraints:
  - id: no-http-in-components
    description: Components do not make direct HTTP calls.
    forbid: { edge: calls_http, from: Component }
```

`angular_check_rules` evaluates them against a diff, a file list, or the whole
project. See [`docs/RULES.md`](docs/RULES.md) for the full schema.

## Documentation

- [`docs/TOOLS.md`](docs/TOOLS.md) — every tool, with real output from the fixtures.
- [`docs/RULES.md`](docs/RULES.md) — the rules file schema and the importers.
- [`docs/PLAN.md`](docs/PLAN.md) — the design: principles, phases, risks and their mitigations.
- [`evals/evaluation.xml`](evals/evaluation.xml) — ten questions about the fixtures, each answerable with the read-only tools and verified against the running server.
- [`docs/BENCHMARK.md`](docs/BENCHMARK.md) — what section 10 asks for, what was measured, and the target that is not met.
- [`docs/adr/`](docs/adr/) — the decisions with the most consequence for this codebase, each with the evidence that settled it.

## Development

```bash
pnpm -C packages/server lint
pnpm -C packages/server typecheck
pnpm -C packages/server test
```

`fixtures/standalone-app` and `fixtures/ngmodule-app` are real Angular 18
applications built to cover the cases that matter: standalone and NgModule
declarations, every reactive primitive, all five modern control-flow forms,
functional and class guards, resolvers and interceptors, lazy routes, barrels,
three different URL shapes, and one deliberately planted architecture violation.
Each has an `expected-graph.json` written by hand from its source — the
integration test measures the indexer against it rather than against itself.

`fixtures/v20-app` is the second half of the version matrix: a minimal Angular
20 install, holding only the packages the indexer resolves, so CI can install
it in seconds. It is what actually exercises the behaviour that differs between
majors — most sharply the `standalone` default, which flipped in Angular 19 and
which the server reads from the analyzed project rather than assuming.

```bash
npm --prefix fixtures/v20-app install   # needed once, for the matrix tests
```

Without it those tests skip themselves rather than fail confusingly.

## Status

All five phases of [`docs/PLAN.md`](docs/PLAN.md) are implemented: the indexer
and ten query tools, the rules engine and its three, the pattern and contract
tools, the MCP server with its resources and prompt, and the three bounded
mutations.

The section 10 benchmark is **partly** done, and one of its targets is **not
met**. Measured: full files read per task −100%, context per task −45% against
a −50% target, incremental indexing 0.9 s, graph precision 100%. Not measured:
turns to first correct edit and task success rate, which need an agent driven
three times on each side and cannot be derived from the repository.

[`docs/BENCHMARK.md`](docs/BENCHMARK.md) has the per-task table, why the two
weakest tasks score as they do, and what someone would have to run to finish
it. The mutations of Phase 5 are built, tested and safe by default, but the
evidence the plan wanted before opening that phase is partial.

## License

To be decided. See the open decisions section of the plan.
