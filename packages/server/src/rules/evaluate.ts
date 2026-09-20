/**
 * Evaluates `angular-mcp.rules.yaml` against the project graph: which layer
 * each file belongs to, whether edges cross a forbidden layer boundary, and
 * every `forbid`/`require` constraint. See docs/PLAN.md, sections 4.1 and
 * 5.3.
 */

import type { ProjectGraph } from '../graph/index.js';
import type { EdgeKind, GraphEdge, GraphNode, NodeId } from '../graph/model.js';
import { normalizeRelativePath } from '../graph/model.js';
import { matchAnyGlob } from './glob.js';
import type { Constraint, RulesFile } from './schema.js';

/**
 * Edge kinds treated as a structural "depends on" relationship for layer
 * boundary checks. Deliberately excludes:
 * - `calls_http`: its target is a synthetic `HttpCall` node that lives in the
 *   same file as its caller (see indexer/extractors/http.ts), so it never
 *   crosses a layer boundary on its own — it is checked through
 *   `constraints` instead (see the `no-http-in-components` example in
 *   docs/RULES.md).
 * - `declares`, `binds`, `emits`, `renders`, `returns`, `intercepted_by`:
 *   same-file or non-architectural relationships.
 * - `tested_by`, `child_of`: test wiring and route nesting, not a dependency
 *   between production layers.
 */
export const BOUNDARY_EDGE_KINDS: readonly EdgeKind[] = [
  'imports',
  'injects',
  'provides',
  'uses_in_template',
  'routes_to',
  'guarded_by',
  'resolves_with',
  'extends',
];

export type ViolationKind = 'boundary' | 'forbid' | 'require';

export interface Violation {
  readonly kind: ViolationKind;
  /** The constraint id for `forbid`/`require`; a synthetic id for `boundary`. */
  readonly ruleId: string;
  readonly severity: 'error' | 'warning';
  readonly message: string;
  readonly file: string;
  readonly line?: number;
  /** The offending edge, for `boundary`/`forbid` violations. */
  readonly edge?: GraphEdge;
  /** The offending node, for `require` violations. */
  readonly node?: GraphNode;
  /** A glob from a layer that IS allowed to hold this dependency, when the rules make one derivable. */
  readonly suggestedPath?: string;
}

export interface EvaluateOptions {
  /** Restricts boundary/forbid checks to these edges. Defaults to every edge in the graph. */
  readonly edges?: readonly GraphEdge[];
  /** Restricts `require` checks to nodes for which this returns true. Defaults to every node. */
  readonly nodeFilter?: (node: GraphNode) => boolean;
}

/** Resolves the layer a file belongs to: the first layer (in declaration order) whose glob matches. */
export function resolveLayerForPath(rules: RulesFile, path: string): string | undefined {
  const normalized = normalizeRelativePath(path);
  for (const [layerName, def] of Object.entries(rules.layers)) {
    if (matchAnyGlob(def.match, normalized)) return layerName;
  }
  return undefined;
}

/** The first glob, from the first layer (in declaration order) allowed to depend on `targetLayer`. */
function suggestAllowedPath(rules: RulesFile, targetLayer: string | undefined): string | undefined {
  if (!targetLayer) return undefined;
  for (const [layerName, boundary] of Object.entries(rules.boundaries)) {
    if (!boundary.may_depend_on.includes(targetLayer)) continue;
    const globs = rules.layers[layerName]?.match;
    if (globs && globs.length > 0) return globs[0];
  }
  return undefined;
}

function nodeOf(graph: ProjectGraph, id: NodeId): GraphNode | undefined {
  return graph.getNode(id);
}

function attrValue(node: GraphNode, attr: string): unknown {
  return (node as unknown as Record<string, unknown>)[attr];
}

function evaluateBoundaries(graph: ProjectGraph, rules: RulesFile, edges: readonly GraphEdge[]): Violation[] {
  const violations: Violation[] = [];

  for (const edge of edges) {
    if (!BOUNDARY_EDGE_KINDS.includes(edge.kind)) continue;

    const fromNode = nodeOf(graph, edge.from);
    const toNode = nodeOf(graph, edge.to);
    if (!fromNode || !toNode) continue;

    const fromLayer = resolveLayerForPath(rules, fromNode.path);
    const toLayer = resolveLayerForPath(rules, toNode.path);
    // An edge whose endpoint's layer cannot be resolved is never flagged:
    // nothing is guessed (P4/R7).
    if (!fromLayer || !toLayer || fromLayer === toLayer) continue;

    const allowed = rules.boundaries[fromLayer]?.may_depend_on.includes(toLayer) ?? false;
    if (allowed) continue;

    violations.push({
      kind: 'boundary',
      ruleId: `boundary:${fromLayer}->${toLayer}`,
      severity: 'error',
      message:
        `Layer "${fromLayer}" may not depend on layer "${toLayer}" ` +
        `(a "${edge.kind}" edge from "${fromNode.id}" to "${toNode.id}"). ` +
        `Declare it under "boundaries.${fromLayer}.may_depend_on" if this dependency is intentional.`,
      file: edge.provenance.file,
      line: edge.provenance.line,
      edge,
      suggestedPath: suggestAllowedPath(rules, toLayer),
    });
  }

  return violations;
}

function matchesForbid(
  graph: ProjectGraph,
  rules: RulesFile,
  edge: GraphEdge,
  forbid: NonNullable<Constraint['forbid']>,
): boolean {
  if (edge.kind !== forbid.edge) return false;

  const fromNode = nodeOf(graph, edge.from);
  if (!fromNode) return false;

  if (forbid.from !== undefined && fromNode.kind !== forbid.from) return false;

  if (forbid.from_layer_not !== undefined) {
    const fromLayer = resolveLayerForPath(rules, fromNode.path);
    // Unresolved layer: never flagged, matches the same rationale as evaluateBoundaries.
    if (fromLayer === undefined || fromLayer === forbid.from_layer_not) return false;
  }

  return true;
}

function evaluateForbidConstraints(graph: ProjectGraph, rules: RulesFile, edges: readonly GraphEdge[]): Violation[] {
  const violations: Violation[] = [];

  for (const constraint of rules.constraints) {
    if (!constraint.forbid) continue;
    const forbid = constraint.forbid;

    for (const edge of edges) {
      if (!matchesForbid(graph, rules, edge, forbid)) continue;

      const toNode = nodeOf(graph, edge.to);
      const targetLayer = toNode ? resolveLayerForPath(rules, toNode.path) : undefined;
      const requiredLayer = forbid.from_layer_not;
      const suggestedPath = requiredLayer !== undefined
        ? rules.layers[requiredLayer]?.match[0]
        : suggestAllowedPath(rules, targetLayer);

      violations.push({
        kind: 'forbid',
        ruleId: constraint.id,
        severity: constraint.severity,
        message: `${constraint.description} (constraint "${constraint.id}": forbidden "${edge.kind}" edge from "${edge.from}").`,
        file: edge.provenance.file,
        line: edge.provenance.line,
        edge,
        suggestedPath,
      });
    }
  }

  return violations;
}

function evaluateRequireConstraints(
  graph: ProjectGraph,
  rules: RulesFile,
  nodeFilter: (node: GraphNode) => boolean,
): Violation[] {
  const violations: Violation[] = [];

  for (const constraint of rules.constraints) {
    if (!constraint.require) continue;
    const { node: nodeKind, attr, equals } = constraint.require;

    for (const node of graph.nodesByKind(nodeKind)) {
      if (!nodeFilter(node)) continue;
      const actual = attrValue(node, attr);
      if (actual === equals) continue;

      violations.push({
        kind: 'require',
        ruleId: constraint.id,
        severity: constraint.severity,
        message: `${constraint.description} (constraint "${constraint.id}": "${node.id}" has "${attr}" = ${JSON.stringify(actual)}, expected ${JSON.stringify(equals)}).`,
        file: node.path,
        node,
      });
    }
  }

  return violations;
}

/**
 * Evaluates `rules` against `graph`: layer boundaries plus every `forbid`/
 * `require` constraint. With no `options`, the whole graph is checked;
 * diff.ts passes a restricted `edges`/`nodeFilter` to check only what a diff
 * touched.
 */
export function evaluateRules(graph: ProjectGraph, rules: RulesFile, options: EvaluateOptions = {}): Violation[] {
  const edges = options.edges ?? graph.allEdges();
  const nodeFilter = options.nodeFilter ?? ((): boolean => true);

  return [
    ...evaluateBoundaries(graph, rules, edges),
    ...evaluateForbidConstraints(graph, rules, edges),
    ...evaluateRequireConstraints(graph, rules, nodeFilter),
  ];
}
