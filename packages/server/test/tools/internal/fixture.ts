/**
 * A small, hand-built project graph shared by most tool tests, so each test
 * can exercise a tool's logic without running the real TypeScript/Angular
 * indexer (that part already has its own tests under test/indexer/).
 *
 * Shape (see docs/PLAN.md section 5 for the edge directions this mirrors):
 *
 *   AppComponent --renders--> AppTemplate --uses_in_template--> UserListComponent
 *   UserListComponent --renders--> UserListTemplate --binds(signal "count")--> (component's own "count" signal)
 *   UserListComponent --injects--> UserService
 *   UserService --calls_http--> HttpCall (GET /api/users)
 *   UserService --tested_by--> Spec
 *   Route "users" --routes_to--> UserListComponent
 *   Route "admin" <--child_of-- Route "admin/users" --routes_to--> AdminUserListComponent
 *   Route "admin/users" --guarded_by--> Guard, --resolves_with--> Resolver
 *
 * `UserListComponent` intentionally shares its bare name with a second,
 * unrelated component (`AdminUserListComponent` is named differently on
 * purpose so most tests are unambiguous) — `AMBIGUOUS_NAME` is a distinct
 * pair of nodes with the exact same name, for R13 tests.
 */

import * as typescript from 'typescript';

import { ProjectGraph } from '../../../src/graph/index.js';
import { makeNodeId } from '../../../src/graph/model.js';
import type {
  BindsEdge,
  CallsHttpEdge,
  ChildOfEdge,
  ComponentNode,
  GuardedByEdge,
  GuardNode,
  HttpCallNode,
  InjectsEdge,
  ResolverNode,
  ResolvesWithEdge,
  RendersEdge,
  RouteNode,
  RoutesToEdge,
  ServiceNode,
  SignalNode,
  SpecNode,
  TemplateNode,
  TestedByEdge,
  UsesInTemplateEdge,
} from '../../../src/graph/model.js';
import type { IndexResult } from '../../../src/indexer/index.js';
import type { ResolvedProjectDependencies } from '../../../src/indexer/resolve.js';
import type { Workspace } from '../../../src/indexer/workspace.js';
import { ToolContext } from '../../../src/tools/internal/context.js';

export const FIXTURE_ROOT = '/fixture/demo-app';

export interface Fixture {
  readonly context: ToolContext;
  readonly graph: ProjectGraph;
  readonly root: string;
  readonly ids: {
    readonly userListComponent: string;
    readonly userListTemplate: string;
    readonly userListSignal: string;
    readonly adminUserListComponent: string;
    readonly appComponent: string;
    readonly appTemplate: string;
    readonly userService: string;
    readonly httpCall: string;
    readonly spec: string;
    readonly routeUsers: string;
    readonly routeAdmin: string;
    readonly routeAdminUsers: string;
    readonly guard: string;
    readonly resolver: string;
  };
}

/** Bare name shared by two distinct, unrelated Component nodes (R13: ambiguous by name). */
export const AMBIGUOUS_NAME = 'DuplicateNameComponent';

export function buildFixture(): Fixture {
  const graph = new ProjectGraph();

  const userListPath = 'src/app/user-list/user-list.component.ts';
  const userListComponentId = makeNodeId(userListPath, 'UserListComponent');
  const userListSignalId = makeNodeId(userListPath, 'UserListComponent.count');
  const userListTemplateId = makeNodeId(userListPath, 'Template');

  const userListComponent: ComponentNode = {
    id: userListComponentId,
    kind: 'Component',
    path: userListPath,
    name: 'UserListComponent',
    selector: 'app-user-list',
    standalone: true,
    changeDetection: 'OnPush',
    inlineTemplate: true,
    stylePaths: [],
    inputs: [{ name: 'page', typeText: 'number', required: false, isSignal: false }],
    outputs: [{ name: 'pageChange', typeText: 'number', isSignal: false }],
    signals: [userListSignalId],
    lifecycleHooks: ['ngOnInit'],
    hostBindings: [],
  };

  const userListSignal: SignalNode = {
    id: userListSignalId,
    kind: 'Signal',
    path: userListPath,
    name: 'count',
    ownerRef: userListComponentId,
    signalKind: 'signal',
    required: false,
    typeText: 'number',
  };

  const userListTemplate: TemplateNode = {
    id: userListTemplateId,
    kind: 'Template',
    path: userListPath,
    name: 'Template',
    inline: true,
    parseErrors: [],
  };

  const rendersUserList: RendersEdge = {
    kind: 'renders',
    from: userListComponentId,
    to: userListTemplateId,
    provenance: { file: userListPath, line: 1, column: 1 },
    confidence: 'certain',
  };

  const bindsCount: BindsEdge = {
    kind: 'binds',
    from: userListTemplateId,
    to: makeNodeId(userListPath, 'count'),
    provenance: { file: userListPath, line: 2, column: 5 },
    confidence: 'certain',
    bindingKind: 'interpolation',
    memberName: 'count',
    targetKind: 'signal',
  };

  const servicePath = 'src/app/user.service.ts';
  const userServiceId = makeNodeId(servicePath, 'UserService');
  const httpCallId = makeNodeId(servicePath, 'UserService.getUsers');

  const userService: ServiceNode = {
    id: userServiceId,
    kind: 'Service',
    path: servicePath,
    name: 'UserService',
    providedIn: 'root',
    isInjectable: true,
  };

  const httpCall: HttpCallNode = {
    id: httpCallId,
    kind: 'HttpCall',
    path: servicePath,
    name: 'getUsers',
    method: 'get',
    urlPattern: '/api/users',
    urlConfidence: 'literal',
    responseTypeText: 'User[]',
    callerRef: userServiceId,
  };

  const injectsService: InjectsEdge = {
    kind: 'injects',
    from: userListComponentId,
    to: userServiceId,
    provenance: { file: userListPath, line: 3, column: 3 },
    confidence: 'certain',
    via: 'inject',
    optional: false,
  };

  const callsHttp: CallsHttpEdge = {
    kind: 'calls_http',
    from: userServiceId,
    to: httpCallId,
    provenance: { file: servicePath, line: 5, column: 5 },
    confidence: 'certain',
  };

  const specPath = 'src/app/user.service.spec.ts';
  const specId = makeNodeId(specPath, 'Spec');
  const spec: SpecNode = {
    id: specId,
    kind: 'Spec',
    path: specPath,
    name: 'Spec',
    describes: ['UserService'],
    testedRefs: [userServiceId],
  };

  const testedBy: TestedByEdge = {
    kind: 'tested_by',
    from: userServiceId,
    to: specId,
    provenance: { file: specPath, line: 1, column: 1 },
    confidence: 'inferred',
  };

  const appPath = 'src/app/app.component.ts';
  const appComponentId = makeNodeId(appPath, 'AppComponent');
  const appTemplateId = makeNodeId(appPath, 'Template');

  const appComponent: ComponentNode = {
    id: appComponentId,
    kind: 'Component',
    path: appPath,
    name: 'AppComponent',
    selector: 'app-root',
    standalone: true,
    changeDetection: 'Default',
    inlineTemplate: true,
    stylePaths: [],
    inputs: [],
    outputs: [],
    signals: [],
    lifecycleHooks: [],
    hostBindings: [],
  };

  const appTemplate: TemplateNode = {
    id: appTemplateId,
    kind: 'Template',
    path: appPath,
    name: 'Template',
    inline: true,
    parseErrors: [],
  };

  const rendersApp: RendersEdge = {
    kind: 'renders',
    from: appComponentId,
    to: appTemplateId,
    provenance: { file: appPath, line: 1, column: 1 },
    confidence: 'certain',
  };

  const usesUserList: UsesInTemplateEdge = {
    kind: 'uses_in_template',
    from: appTemplateId,
    to: userListComponentId,
    provenance: { file: appPath, line: 2, column: 3 },
    confidence: 'certain',
    selector: 'app-user-list',
  };

  const adminUserListPath = 'src/app/admin/admin-user-list.component.ts';
  const adminUserListComponentId = makeNodeId(adminUserListPath, 'AdminUserListComponent');
  const adminUserListComponent: ComponentNode = {
    id: adminUserListComponentId,
    kind: 'Component',
    path: adminUserListPath,
    name: 'AdminUserListComponent',
    selector: 'app-admin-user-list',
    standalone: true,
    changeDetection: 'OnPush',
    inlineTemplate: true,
    stylePaths: [],
    inputs: [],
    outputs: [],
    signals: [],
    lifecycleHooks: [],
    hostBindings: [],
  };

  const routesPath = 'src/app/app.routes.ts';
  const routeUsersId = makeNodeId(routesPath, 'Route@1:1');
  const routeUsers: RouteNode = {
    id: routeUsersId,
    kind: 'Route',
    path: routesPath,
    name: 'users',
    routePath: 'users',
    componentRef: userListComponentId,
    lazy: false,
    guards: [],
    resolvers: [],
    children: [],
  };

  const routesToUsers: RoutesToEdge = {
    kind: 'routes_to',
    from: routeUsersId,
    to: userListComponentId,
    provenance: { file: routesPath, line: 1, column: 1 },
    confidence: 'certain',
  };

  const routeAdminId = makeNodeId(routesPath, 'Route@5:1');
  const adminRoutesPath = 'src/app/admin/admin.routes.ts';
  const routeAdminUsersId = makeNodeId(adminRoutesPath, 'Route@1:1');

  const guardPath = 'src/app/admin/admin.guard.ts';
  const guardId = makeNodeId(guardPath, 'adminGuard');
  const guard: GuardNode = { id: guardId, kind: 'Guard', path: guardPath, name: 'adminGuard', guardKind: 'functional' };

  const resolverPath = 'src/app/admin/user.resolver.ts';
  const resolverId = makeNodeId(resolverPath, 'userResolver');
  const resolver: ResolverNode = {
    id: resolverId,
    kind: 'Resolver',
    path: resolverPath,
    name: 'userResolver',
    resolverKind: 'functional',
  };

  const routeAdmin: RouteNode = {
    id: routeAdminId,
    kind: 'Route',
    path: routesPath,
    name: 'admin',
    routePath: 'admin',
    lazy: false,
    guards: [],
    resolvers: [],
    children: [routeAdminUsersId],
  };

  const routeAdminUsers: RouteNode = {
    id: routeAdminUsersId,
    kind: 'Route',
    path: adminRoutesPath,
    name: 'users',
    routePath: 'users',
    componentRef: adminUserListComponentId,
    lazy: false,
    guards: [guardId],
    resolvers: [resolverId],
    children: [],
  };

  const childOf: ChildOfEdge = {
    kind: 'child_of',
    from: routeAdminUsersId,
    to: routeAdminId,
    provenance: { file: adminRoutesPath, line: 1, column: 1 },
    confidence: 'certain',
  };

  const routesToAdminUsers: RoutesToEdge = {
    kind: 'routes_to',
    from: routeAdminUsersId,
    to: adminUserListComponentId,
    provenance: { file: adminRoutesPath, line: 1, column: 1 },
    confidence: 'certain',
  };

  const guardedBy: GuardedByEdge = {
    kind: 'guarded_by',
    from: routeAdminUsersId,
    to: guardId,
    provenance: { file: adminRoutesPath, line: 1, column: 1 },
    confidence: 'certain',
  };

  const resolvesWith: ResolvesWithEdge = {
    kind: 'resolves_with',
    from: routeAdminUsersId,
    to: resolverId,
    provenance: { file: adminRoutesPath, line: 1, column: 1 },
    confidence: 'certain',
  };

  // R13: two distinct, unrelated components sharing the exact same bare name.
  const dup1Path = 'src/app/one/duplicate-name.component.ts';
  const dup2Path = 'src/app/two/duplicate-name.component.ts';
  const dup1: ComponentNode = {
    id: makeNodeId(dup1Path, AMBIGUOUS_NAME),
    kind: 'Component',
    path: dup1Path,
    name: AMBIGUOUS_NAME,
    standalone: true,
    changeDetection: 'Default',
    inlineTemplate: true,
    stylePaths: [],
    inputs: [],
    outputs: [],
    signals: [],
    lifecycleHooks: [],
    hostBindings: [],
  };
  const dup2: ComponentNode = { ...dup1, id: makeNodeId(dup2Path, AMBIGUOUS_NAME), path: dup2Path };

  graph.addNodes([
    userListComponent,
    userListSignal,
    userListTemplate,
    userService,
    httpCall,
    spec,
    appComponent,
    appTemplate,
    adminUserListComponent,
    routeUsers,
    routeAdmin,
    routeAdminUsers,
    guard,
    resolver,
    dup1,
    dup2,
  ]);

  graph.addEdges([
    rendersUserList,
    bindsCount,
    injectsService,
    callsHttp,
    testedBy,
    rendersApp,
    usesUserList,
    routesToUsers,
    childOf,
    routesToAdminUsers,
    guardedBy,
    resolvesWith,
  ]);

  const root = FIXTURE_ROOT;
  const context = new ToolContext({ defaultRoot: root });

  const stats: IndexResult['stats'] = {
    nodesByType: { Component: 4, Service: 1 },
    filesProcessed: 8,
    filesReindexed: 8,
    filesReused: 0,
    filesRemoved: 0,
    elapsedMs: 12,
    parseErrors: [],
    brokenFiles: [],
  };

  const deps: ResolvedProjectDependencies = {
    typescript,
    typescriptVersion: typescript.version,
    angularCompiler: {},
    angularVersion: { full: '18.2.0', major: 18 },
  };

  const workspace: Workspace = {
    root,
    kind: 'angular-cli',
    configPath: `${root}/angular.json`,
    projects: [
      { name: 'demo-app', projectType: 'application', root: '' },
      { name: 'admin', projectType: 'library', root: 'src/app/admin' },
    ],
  };

  context.setState({ root, result: { graph, stats }, deps, workspace, indexedAtMs: Date.now() });

  return {
    context,
    graph,
    root,
    ids: {
      userListComponent: userListComponentId,
      userListTemplate: userListTemplateId,
      userListSignal: userListSignalId,
      adminUserListComponent: adminUserListComponentId,
      appComponent: appComponentId,
      appTemplate: appTemplateId,
      userService: userServiceId,
      httpCall: httpCallId,
      spec: specId,
      routeUsers: routeUsersId,
      routeAdmin: routeAdminId,
      routeAdminUsers: routeAdminUsersId,
      guard: guardId,
      resolver: resolverId,
    },
  };
}
