/**
 * Ref resolution shared by every tool that takes a `ref` (docs/PLAN.md risk
 * R13): a full "path#Name" id always resolves to at most one node, by
 * construction. A bare name is accepted as a convenience, but a bare name
 * that matches more than one indexed symbol is never resolved by guessing —
 * `AmbiguousRefError` is thrown with the full candidate list instead.
 */

import type { ProjectGraph } from '../../graph/index.js';
import type { GraphNode, NodeKind } from '../../graph/model.js';

import { AmbiguousRefError, RefNotFoundError } from './errors.js';
import type { RefCandidate } from './errors.js';

export function toCandidate(node: GraphNode): RefCandidate {
  return { id: node.id, kind: node.kind, name: node.name, path: node.path };
}

/**
 * Resolves `ref` to exactly one node, optionally restricted to `kindFilter`.
 * Throws `RefNotFoundError` when nothing matches, and `AmbiguousRefError`
 * (R13) when a bare name matches more than one node.
 */
export function resolveRef(graph: ProjectGraph, ref: string, kindFilter?: NodeKind): GraphNode {
  if (ref.includes('#')) {
    const node = graph.getNode(ref);
    if (!node || (kindFilter && node.kind !== kindFilter)) {
      throw new RefNotFoundError(ref, kindFilter);
    }
    return node;
  }

  const matches = graph.nodesByName(ref).filter((node) => !kindFilter || node.kind === kindFilter);
  if (matches.length === 0) throw new RefNotFoundError(ref, kindFilter);
  if (matches.length > 1) throw new AmbiguousRefError(ref, matches.map(toCandidate));
  return matches[0] as GraphNode;
}
