/**
 * `angular_get_route_tree` — docs/PLAN.md, section 6, Phase 1.
 *
 * Flattens the route graph (`Route` nodes plus `routes_to`/`child_of`/
 * `guarded_by`/`resolves_with` edges) into one list, each entry carrying its
 * full path (joined from the root), its target component, its lazy-loading
 * shape, its guards and resolvers, and its parent/children ids for
 * programmatic reconstruction under `format: "json"`.
 */

import { z } from 'zod';

import { formatFacts } from '../format/index.js';
import type { Fact } from '../format/index.js';
import type { Confidence, GuardNode, ResolverNode, RouteNode } from '../graph/model.js';

import { defineTool, READ_ONLY_ANNOTATIONS } from './internal/define.js';
import { InvalidInputError } from './internal/errors.js';
import { makeFact } from './internal/facts.js';
import { formattedResponseSchema, pagingInputShape, rootInputField } from './internal/schemas.js';

const DEFAULT_DEPTH = 5;
const MAX_DEPTH = 10;

const inputSchema = {
  root: rootInputField,
  project: z
    .string()
    .optional()
    .describe('Name of a project declared in angular.json: only routes declared under that project\'s folder are returned.'),
  path_prefix: z
    .string()
    .optional()
    .describe('Only return routes whose full joined path (parent segments included) starts with this prefix, e.g. "admin/users".'),
  depth: z
    .number()
    .int()
    .min(0)
    .max(MAX_DEPTH)
    .optional()
    .describe(`Maximum nesting depth (levels of "children") to include. Defaults to ${DEFAULT_DEPTH} (docs/PLAN.md P6).`),
  ...pagingInputShape,
};

const outputSchema = {
  project: z.string().optional(),
  pathPrefix: z.string().optional(),
  depth: z.number().int(),
  totalRoutes: z.number().int().describe('Total Route nodes in the graph, before any filtering.'),
  result: formattedResponseSchema.describe(
    'One fact per route: full path, target component, lazy-loading, guards and resolvers. Component/guard/resolver ' +
      'resolutions from a route are "certain" for a local symbol and "inferred" for one resolved through a ' +
      'relative import specifier that was not checked against disk (docs/PLAN.md risk R7); "unknown" when the ' +
      'shape could not be recognized at all.',
  ),
};

function fullPathOf(route: RouteNode, byId: ReadonlyMap<string, RouteNode>, parentOf: ReadonlyMap<string, string>): string {
  const segments: string[] = [];
  let current: RouteNode | undefined = route;
  const visited = new Set<string>();

  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    if (current.routePath.length > 0) segments.unshift(current.routePath);
    const parentId = parentOf.get(current.id);
    current = parentId ? byId.get(parentId) : undefined;
  }

  return segments.join('/');
}

function lazySummary(route: RouteNode): string {
  return route.lazy ? ` [lazy:${route.lazy.kind}]` : '';
}

function routeConfidence(route: RouteNode, componentEdgeConfidence: Confidence | undefined): Confidence {
  if (route.componentRef) return componentEdgeConfidence ?? 'unknown';
  if (route.lazy) return route.lazy.confidence;
  return 'certain';
}

export const getRouteTreeTool = defineTool({
  name: 'angular_get_route_tree',
  description:
    'Flattens the routing configuration into a list of routes, each with its full path, target component, ' +
    'lazy-loading kind, guards and resolvers, and its parent/children refs. Filter by "project" (an angular.json ' +
    'project folder) or "path_prefix". A route\'s component/guard/resolver ref is "certain" when it is a local ' +
    'symbol, "inferred" when resolved through a relative import path that was not checked against disk, and ' +
    '"unknown" when the shape (e.g. a dynamic loadChildren) could not be recognized (docs/PLAN.md risk R7).',
  inputSchema,
  outputSchema,
  annotations: { ...READ_ONLY_ANNOTATIONS, title: 'Get route tree' },
  async handler(input, context) {
    const root = context.resolveRoot(input.root);
    const graph = context.requireGraph(root);
    const depth = input.depth ?? DEFAULT_DEPTH;

    let allowedPathPrefix: string | undefined;
    if (input.project !== undefined) {
      const state = context.getStateFor(root);
      const project = state?.workspace.projects.find((p) => p.name === input.project);
      if (!project) {
        const known = state?.workspace.projects.map((p) => p.name) ?? [];
        throw new InvalidInputError(
          `Project "${input.project}" is not declared in this workspace. Known projects: ${known.length > 0 ? known.join(', ') : '(none found)'}.`,
        );
      }
      allowedPathPrefix = project.root.length > 0 ? `${project.root}/` : undefined;
    }

    const allRoutes = graph.nodesByKind('Route') as RouteNode[];
    const byId = new Map(allRoutes.map((route) => [route.id, route] as const));

    const parentOf = new Map<string, string>();
    for (const route of allRoutes) {
      const parentEdge = graph.edgesFrom(route.id, 'child_of')[0];
      if (parentEdge) parentOf.set(route.id, parentEdge.to);
    }

    const depthOf = new Map<string, number>();
    const roots = allRoutes.filter((route) => !parentOf.has(route.id));
    let frontier = roots;
    let level = 0;
    for (const route of roots) depthOf.set(route.id, 0);
    while (frontier.length > 0 && level < depth) {
      const next: RouteNode[] = [];
      for (const route of frontier) {
        for (const childId of route.children) {
          const child = byId.get(childId);
          if (!child || depthOf.has(child.id)) continue;
          depthOf.set(child.id, level + 1);
          next.push(child);
        }
      }
      frontier = next;
      level += 1;
    }

    const scoped = allRoutes.filter((route) => {
      if (!depthOf.has(route.id)) return false;
      if (allowedPathPrefix && !route.path.startsWith(allowedPathPrefix)) return false;
      return true;
    });

    const withPaths = scoped.map((route) => ({ route, fullPath: fullPathOf(route, byId, parentOf) }));
    const matched = input.path_prefix
      ? withPaths.filter(({ fullPath }) => fullPath.startsWith(input.path_prefix as string))
      : withPaths;

    matched.sort((a, b) => (depthOf.get(a.route.id) ?? 0) - (depthOf.get(b.route.id) ?? 0) || a.fullPath.localeCompare(b.fullPath));

    const facts: Fact[] = matched.map(({ route, fullPath }) => {
      const componentEdge = route.componentRef ? graph.edgesFrom(route.id, 'routes_to')[0] : undefined;
      const component = route.componentRef ? graph.getNode(route.componentRef) : undefined;
      const guards = route.guards.map((id) => graph.getNode(id) as GuardNode | undefined).filter((g): g is GuardNode => !!g);
      const resolvers = route.resolvers
        .map((id) => graph.getNode(id) as ResolverNode | undefined)
        .filter((r): r is ResolverNode => !!r);

      const guardSummary = guards.length > 0 ? `, guards: ${guards.map((g) => g.name).join(', ')}` : '';
      const resolverSummary = resolvers.length > 0 ? `, resolvers: ${resolvers.map((r) => r.name).join(', ')}` : '';

      return makeFact({
        kind: 'Route',
        summary: `/${fullPath}${lazySummary(route)} → ${component?.name ?? route.componentRef ?? '(no component)'}${guardSummary}${resolverSummary}`,
        provenance: { file: route.path },
        confidence: routeConfidence(route, componentEdge?.confidence),
        detail: {
          id: route.id,
          routePath: route.routePath,
          fullPath,
          parentId: parentOf.get(route.id),
          children: route.children,
          componentRef: route.componentRef,
          lazy: route.lazy,
          guards: route.guards,
          resolvers: route.resolvers,
          data: route.data,
        },
      });
    });

    return {
      project: input.project,
      pathPrefix: input.path_prefix,
      depth,
      totalRoutes: allRoutes.length,
      result: formatFacts(facts, {
        limit: input.limit,
        offset: input.offset,
        format: input.format,
        title: 'Route tree',
      }),
    };
  },
});
