/**
 * The five benchmark tasks from docs/PLAN.md, section 10.
 *
 * Each task pairs two things that can be measured without running an agent:
 *
 * - `baselineFiles`: the files whose contents actually hold the answer. An
 *   agent working without this server has to read them to get the same facts.
 *   The list is deliberately the *minimum* — what a perfectly informed agent
 *   would open, with no exploratory reads, no greps and no dead ends. Real
 *   sessions read more, so every number this produces understates the
 *   server's advantage rather than flattering it.
 *
 * - `calls`: the tool calls that answer the same question through the server.
 *
 * What this measures is **context cost**: how many bytes of the model's window
 * each route consumes. It is not the full section 10 benchmark, which also
 * asks for turns-to-first-edit and task success rate across three repetitions
 * — those need a real agent run on both sides and cannot be derived from the
 * repository. See docs/BENCHMARK.md for what is and is not covered.
 */

export interface BenchToolCall {
  readonly tool: string;
  readonly args: Record<string, unknown>;
}

export interface BenchTask {
  readonly id: string;
  /** The task as a person would put it to an agent. */
  readonly prompt: string;
  /** What the agent has to know before it can make the edit. */
  readonly factsNeeded: readonly string[];
  /** Minimum file set holding those facts, relative to the fixture root. */
  readonly baselineFiles: readonly string[];
  readonly calls: readonly BenchToolCall[];
}

export const FIXTURE = 'standalone-app';

export const BENCH_TASKS: readonly BenchTask[] = [
  {
    id: 'add-pagination',
    prompt: 'Add server-side pagination to the user list, following whatever pattern this codebase already uses.',
    factsNeeded: [
      "UserListComponent's inputs, signals and injected service",
      'an existing paginated component to copy the pattern from',
      "UserService's HTTP call for users",
      'the specs that cover both',
    ],
    baselineFiles: [
      'src/app/features/users/user-list/user-list.component.ts',
      'src/app/features/users/user-list/user-list.component.html',
      'src/app/features/orders/order-list/order-list.component.ts',
      'src/app/core/services/user.service.ts',
      'src/app/features/users/user-list/user-list.component.spec.ts',
      'src/app/core/services/user.service.spec.ts',
    ],
    calls: [
      { tool: 'angular_get_component', args: { ref: 'UserListComponent' } },
      { tool: 'angular_find_similar', args: { ref: 'UserListComponent', limit: 3 } },
      { tool: 'angular_get_service', args: { ref: 'UserService' } },
      { tool: 'angular_impact_of', args: { refs: ['UserService'], depth: 2 } },
    ],
  },
  {
    id: 'change-endpoint',
    prompt: 'The users endpoint is moving to /v2/users. Change every call that targets it and update whatever depends on them.',
    factsNeeded: [
      'every HTTP call whose URL mentions users',
      'how each URL is built, and whether it can be resolved statically',
      'who consumes the service that makes them',
      'the specs affected',
    ],
    baselineFiles: [
      'src/app/core/services/user.service.ts',
      'src/environments/environment.ts',
      'src/app/features/users/user-list/user-list.component.ts',
      'src/app/core/services/user.service.spec.ts',
    ],
    calls: [
      { tool: 'angular_list_http_calls', args: { url_pattern: 'users' } },
      { tool: 'angular_who_uses', args: { ref: 'UserService' } },
      { tool: 'angular_impact_of', args: { refs: ['UserService'], depth: 2 } },
    ],
  },
  {
    id: 'add-route',
    prompt: 'Add a /reports route that loads a ReportListComponent, matching how the other routes in this app are declared.',
    factsNeeded: [
      'where the top-level routes live',
      'whether routes here load lazily or eagerly',
      'the shape of an existing lazy entry',
    ],
    baselineFiles: [
      'src/app/app.routes.ts',
      'src/app/features/orders/orders.routes.ts',
      'src/app/app.config.ts',
    ],
    calls: [
      { tool: 'angular_get_route_tree', args: {} },
      {
        tool: 'angular_add_route',
        args: {
          file: 'src/app/app.routes.ts',
          array_name: 'routes',
          path: 'reports',
          component: 'ReportListComponent',
          component_path: './features/reports/report-list.component',
        },
      },
    ],
  },
  {
    id: 'find-violation',
    prompt: 'One component talks to HttpClient directly instead of going through a service. Find it and say what it should do instead.',
    factsNeeded: [
      'which components call HttpClient',
      'which layer each file belongs to',
      'what that layer is allowed to depend on',
    ],
    baselineFiles: [
      'src/app/features/orders/order-detail/order-detail.component.ts',
      'src/app/features/orders/order-list/order-list.component.ts',
      'src/app/features/users/user-list/user-list.component.ts',
      'src/app/app.component.ts',
      'src/app/core/services/order.service.ts',
      'src/app/core/services/user.service.ts',
    ],
    calls: [
      { tool: 'angular_list_http_calls', args: {} },
      { tool: 'angular_explain_layer', args: { file: 'src/app/features/orders/order-detail/order-detail.component.ts' } },
    ],
  },
  {
    id: 'auth-header',
    prompt: 'Every outgoing request has to carry an auth header. Where is that done today, and which calls does it affect?',
    factsNeeded: [
      'whether an interceptor exists and where it is registered',
      'every HTTP call it would see',
      'which services and components those calls belong to',
    ],
    baselineFiles: [
      'src/app/app.config.ts',
      'src/app/core/interceptors/auth.interceptor.ts',
      'src/app/core/services/user.service.ts',
      'src/app/core/services/order.service.ts',
      'src/app/features/orders/order-detail/order-detail.component.ts',
    ],
    calls: [
      { tool: 'angular_find_symbol', args: { query: 'interceptor' } },
      { tool: 'angular_list_http_calls', args: { limit: 10 } },
      { tool: 'angular_impact_of', args: { refs: ['UserService'], depth: 3 } },
    ],
  },
];
