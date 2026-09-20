/**
 * `angular_impact_of` — docs/PLAN.md, section 6, Phase 1. "I'm about to
 * touch X": the affected subgraph, both upward (consumers) and downward
 * (dependencies), grouped by node kind, plus the specs reached — every
 * traversal bounded by `depth` (P6, docs/PLAN.md section 2).
 */

import { z } from 'zod';

import { formatFacts } from '../format/index.js';
import type { Fact } from '../format/index.js';
import type { GraphNode } from '../graph/model.js';

import { defineTool, READ_ONLY_ANNOTATIONS } from './internal/define.js';
import { InvalidInputError, ToolError } from './internal/errors.js';
import { makeFact } from './internal/facts.js';
import { resolveRef, toCandidate } from './internal/refs.js';
import { candidateSchema, formattedResponseSchema, pagingInputShape, rootInputField } from './internal/schemas.js';

const DEFAULT_DEPTH = 3;
const MAX_DEPTH = 10;

const inputSchema = {
  root: rootInputField,
  refs: z
    .array(z.string().min(1))
    .optional()
    .describe('Full refs ("path#Name") or bare names of the symbols about to change. At least one of "refs"/"files" is required.'),
  files: z
    .array(z.string().min(1))
    .optional()
    .describe('File paths (relative to root) about to change: every symbol declared in each file is used as a starting point.'),
  depth: z
    .number()
    .int()
    .min(0)
    .max(MAX_DEPTH)
    .optional()
    .describe(`How many hops to walk in each direction (consumers and dependencies). Defaults to ${DEFAULT_DEPTH} (docs/PLAN.md P6).`),
  ...pagingInputShape,
};

const outputSchema = {
  targets: z.array(candidateSchema).describe('The resolved starting symbols (from "refs" and/or "files").'),
  depth: z.number().int(),
  consumerCount: z.number().int(),
  dependencyCount: z.number().int(),
  specCount: z.number().int(),
  result: formattedResponseSchema.describe(
    'One fact per affected node: the target itself, its consumers (upward) and its dependencies (downward), each ' +
      'tagged with its role and the depth it was reached at, plus the specs that reach it through a tested_by edge. ' +
      'Confidence is the traversed edge\'s own (docs/PLAN.md risk R7) — never recomputed.',
  ),
};

type Role = 'target' | 'consumer' | 'dependency' | 'spec';

interface Affected {
  readonly node: GraphNode;
  readonly role: Role;
  readonly depth: number;
}

export const impactOfTool = defineTool({
  name: 'angular_impact_of',
  description:
    'Computes the subgraph affected by changing one or more symbols or files: consumers (upward, who depends on ' +
    'this) and dependencies (downward, what this depends on), each bounded by "depth" hops (docs/PLAN.md P6), plus ' +
    'the specs that reach the target through a tested_by edge. Use this before editing something with a non-obvious ' +
    'blast radius. Requires "refs" and/or "files"; a ref may be a bare name only when it is unambiguous (R13) — ' +
    'call angular_find_symbol first otherwise.',
  inputSchema,
  outputSchema,
  annotations: { ...READ_ONLY_ANNOTATIONS, title: 'Impact of' },
  async handler(input, context) {
    const root = context.resolveRoot(input.root);
    const graph = context.requireGraph(root);
    const depth = input.depth ?? DEFAULT_DEPTH;

    const hasRefs = (input.refs?.length ?? 0) > 0;
    const hasFiles = (input.files?.length ?? 0) > 0;
    if (!hasRefs && !hasFiles) {
      throw new InvalidInputError('Provide at least one of "refs" or "files": there is nothing to compute the impact of.');
    }

    const targets = new Map<string, GraphNode>();

    for (const ref of input.refs ?? []) {
      try {
        const node = resolveRef(graph, ref);
        targets.set(node.id, node);
      } catch (error) {
        if (error instanceof ToolError) {
          throw new InvalidInputError(`Ref "${ref}": ${error.message}`);
        }
        throw error;
      }
    }

    const missingFiles: string[] = [];
    for (const file of input.files ?? []) {
      const nodesInFile = graph.nodesByFile(file);
      if (nodesInFile.length === 0) {
        missingFiles.push(file);
        continue;
      }
      for (const node of nodesInFile) targets.set(node.id, node);
    }

    if (targets.size === 0) {
      throw new InvalidInputError(
        `None of the given refs/files resolved to an indexed symbol. Unresolvable files: ${missingFiles.join(', ') || '(none)'}. ` +
          'Call angular_index_project (if the files are new) or angular_find_symbol (to check a ref) first.',
      );
    }

    const affectedByKey = new Map<string, Affected>();
    const setIfCloser = (node: GraphNode, role: Role, depthReached: number): void => {
      const key = `${role}:${node.id}`;
      const existing = affectedByKey.get(key);
      if (!existing || depthReached < existing.depth) {
        affectedByKey.set(key, { node, role, depth: depthReached });
      }
    };

    for (const target of targets.values()) {
      setIfCloser(target, 'target', 0);

      const consumers = graph.traverse(target.id, { direction: 'in', maxDepth: depth });
      for (const node of consumers.nodes) {
        const nodeDepth = consumers.depthOf.get(node.id) ?? 0;
        if (nodeDepth === 0) continue;
        setIfCloser(node, 'consumer', nodeDepth);
      }

      const dependencies = graph.traverse(target.id, { direction: 'out', maxDepth: depth });
      for (const node of dependencies.nodes) {
        const nodeDepth = dependencies.depthOf.get(node.id) ?? 0;
        if (nodeDepth === 0) continue;
        setIfCloser(node, 'dependency', nodeDepth);
      }
    }

    const specIds = new Set<string>();
    for (const affected of affectedByKey.values()) {
      if (affected.node.kind === 'Spec') continue;
      for (const edge of graph.edgesFrom(affected.node.id, 'tested_by')) {
        specIds.add(edge.to);
      }
    }
    for (const specId of specIds) {
      const spec = graph.getNode(specId);
      if (spec) setIfCloser(spec, 'spec', 0);
    }

    const all = [...affectedByKey.values()].sort((a, b) => {
      const roleOrder: Record<Role, number> = { target: 0, dependency: 1, consumer: 2, spec: 3 };
      return roleOrder[a.role] - roleOrder[b.role] || a.depth - b.depth || a.node.id.localeCompare(b.node.id);
    });

    const facts: Fact[] = all.map(({ node, role, depth: depthReached }) =>
      makeFact({
        kind: node.kind,
        summary: `[${role}${role === 'target' ? '' : ` @${depthReached}`}] ${node.name} (${node.path})`,
        provenance: { file: node.path },
        confidence: 'certain',
        detail: { id: node.id, kind: node.kind, role, depth: depthReached },
      }),
    );

    if (missingFiles.length > 0) {
      for (const file of missingFiles) {
        facts.push(
          makeFact({
            kind: 'UnresolvedFile',
            summary: `"${file}" has no indexed symbols (not found, or nothing was derived from it)`,
            provenance: { file },
            confidence: 'unknown',
            detail: { file },
          }),
        );
      }
    }

    return {
      targets: [...targets.values()].map(toCandidate),
      depth,
      consumerCount: all.filter((a) => a.role === 'consumer').length,
      dependencyCount: all.filter((a) => a.role === 'dependency').length,
      specCount: all.filter((a) => a.role === 'spec').length,
      result: formatFacts(facts, {
        limit: input.limit,
        offset: input.offset,
        format: input.format,
        title: 'Impact of',
      }),
    };
  },
});
