/**
 * `angular_check_rules`: the gatekeeper tool. Evaluates the loaded rules
 * against a unified diff, an explicit file list, or the whole project, and
 * reports every violation with its offending edge, provenance and a
 * suggested allowed path. See docs/PLAN.md, section 6, Phase 2, and its exit
 * criterion: "A diff that introduces HttpClient into a component produces a
 * violation with a suggested allowed path."
 */

import type * as TS from 'typescript';

import type { ProjectGraph } from '../../graph/index.js';
import type { GraphNode } from '../../graph/model.js';
import { normalizeRelativePath } from '../../graph/model.js';
import type { Fact, FormattedResponse, FormatParams } from '../../format/index.js';
import { formatFacts } from '../../format/index.js';
import { indexProject } from '../../indexer/index.js';
import { resolveProjectDependencies } from '../../indexer/resolve.js';
import { evaluateDiff } from '../diff.js';
import type { Violation } from '../evaluate.js';
import { evaluateRules } from '../evaluate.js';
import type { EffectiveRules } from '../load.js';
import { loadEffectiveRules } from '../load.js';

export interface CheckRulesInput extends FormatParams {
  readonly root: string;
  /** A unified diff (as produced by `git diff`). Takes precedence over `files`. */
  readonly diff?: string;
  /** Explicit list of touched file paths, when a diff is not available. */
  readonly files?: readonly string[];
}

export interface CheckRulesToolDeps {
  readonly typescript?: typeof TS;
  readonly angularCompiler?: unknown;
  /** Reuses an already-indexed graph instead of indexing `root` again. */
  readonly graph?: ProjectGraph;
  /** Reuses already-loaded effective rules instead of reading them from disk again. */
  readonly effectiveRules?: EffectiveRules;
}

export interface CheckRulesResult {
  readonly violations: readonly Violation[];
  readonly response: FormattedResponse;
}

function violationSummary(violation: Violation): string {
  const base = violation.line !== undefined ? `${violation.file}:${violation.line}` : violation.file;
  const suggestion = violation.suggestedPath ? ` Suggested allowed path: "${violation.suggestedPath}".` : '';
  return `[${violation.severity}] ${base}: ${violation.message}${suggestion}`;
}

function violationToFact(violation: Violation): Fact {
  return {
    kind: violation.kind,
    summary: violationSummary(violation),
    provenance: { file: violation.file, line: violation.line },
    confidence: 'certain',
    detail: {
      ruleId: violation.ruleId,
      severity: violation.severity,
      edge: violation.edge,
      node: violation.node,
      suggestedPath: violation.suggestedPath,
    },
  };
}

/**
 * Evaluates `rules` against `graph`, scoped by `target`: a diff, an explicit
 * file list, or (with neither) the whole project. Pure and independently
 * testable — `checkRules` below is the MCP-facing wrapper that resolves
 * `graph`/`rules` first.
 */
export function checkRulesAgainstGraph(
  graph: ProjectGraph,
  rules: EffectiveRules['rules'],
  target: { readonly diff?: string; readonly files?: readonly string[] },
): Violation[] {
  if (target.diff !== undefined) {
    return evaluateDiff(graph, rules, target.diff);
  }

  if (target.files !== undefined) {
    const touchedPaths = new Set(target.files.map(normalizeRelativePath));
    const touchedNodeIds = new Set<string>();
    for (const path of touchedPaths) {
      for (const node of graph.nodesByFile(path)) touchedNodeIds.add(node.id);
    }
    const edges = graph.allEdges().filter((edge) => touchedNodeIds.has(edge.from) || touchedNodeIds.has(edge.to));
    return evaluateRules(graph, rules, {
      edges,
      nodeFilter: (node: GraphNode) => touchedNodeIds.has(node.id),
    });
  }

  return evaluateRules(graph, rules);
}

/**
 * Checks the project's rules against `input.diff`, `input.files`, or (with
 * neither) the whole project, and returns every violation, paginated and
 * formatted per `input.limit`/`offset`/`format`.
 */
export async function checkRules(input: CheckRulesInput, deps: CheckRulesToolDeps = {}): Promise<CheckRulesResult> {
  const resolved = deps.typescript && deps.angularCompiler
    ? { typescript: deps.typescript, angularCompiler: deps.angularCompiler }
    : resolveProjectDependencies(input.root);

  const effective = deps.effectiveRules ?? (await loadEffectiveRules(input.root, { typescript: resolved.typescript }));
  const graph = deps.graph ?? (await indexProject({ root: input.root, ...resolved })).graph;

  const violations = checkRulesAgainstGraph(graph, effective.rules, { diff: input.diff, files: input.files });
  const facts = violations.map(violationToFact);

  return {
    violations,
    response: formatFacts(facts, { ...input, title: 'Rule violations' }),
  };
}
