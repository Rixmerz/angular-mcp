/**
 * `angular_find_symbol` — docs/PLAN.md, section 6, Phase 1, and risk R13.
 *
 * Search by name, selector or path. This is the *only* Phase 1 tool allowed
 * to be uncertain about which symbol the caller means: it always returns the
 * list of candidates and never picks one on its own. Every other tool
 * requires a full `path#Name` ref (or a bare name that resolves to exactly
 * one match) — see `internal/refs.ts`.
 */

import { z } from 'zod';

import { formatFacts } from '../format/index.js';
import type { GraphNode } from '../graph/model.js';

import { defineTool, READ_ONLY_ANNOTATIONS } from './internal/define.js';
import { makeFact } from './internal/facts.js';
import { formattedResponseSchema, nodeKindSchema, pagingInputShape, rootInputField } from './internal/schemas.js';

const inputSchema = {
  root: rootInputField,
  query: z
    .string()
    .min(1)
    .describe('Text to search for, case-insensitively, against a symbol\'s name, its selector (for a Component/Directive/Pipe), and its file path.'),
  kind: nodeKindSchema.optional().describe('Restrict results to this node kind (Component, Service, Route, ...).'),
  ...pagingInputShape,
};

const outputSchema = {
  query: z.string(),
  kind: nodeKindSchema.optional(),
  matchCount: z.number().int().describe('Total number of matches, before pagination.'),
  result: formattedResponseSchema.describe(
    'Candidates matching the query, each with its full ref (id), kind, name and path. Always a list — this tool ' +
      'never resolves to a single "best" match on its own (docs/PLAN.md risk R13).',
  ),
};

function selectorOf(node: GraphNode): string | undefined {
  return 'selector' in node && typeof node.selector === 'string' ? node.selector : undefined;
}

function symbolSummary(node: GraphNode): string {
  const selector = selectorOf(node);
  const selectorPart = selector ? ` <${selector}>` : '';
  return `\`${node.id}\`${selectorPart}`;
}

/** 0 = best match. Exact name, then exact selector, then name prefix, then everything else. */
function rankOf(node: GraphNode, query: string): number {
  const lowerName = node.name.toLowerCase();
  if (lowerName === query) return 0;
  const selector = selectorOf(node)?.toLowerCase();
  if (selector === query) return 1;
  if (lowerName.startsWith(query)) return 2;
  return 3;
}

export const findSymbolTool = defineTool({
  name: 'angular_find_symbol',
  description:
    'Searches the indexed project for symbols by name, selector or file path substring. Always returns the list ' +
    'of candidates (each with its full "path#Name" ref) and never guesses a single match (docs/PLAN.md risk R13) — ' +
    'use this first whenever you only know a name, then pass the exact ref it returns to angular_get_component, ' +
    'angular_get_service, angular_who_uses, etc. Matching is a certain, literal substring check; it never infers ' +
    'relevance beyond that.',
  inputSchema,
  outputSchema,
  annotations: { ...READ_ONLY_ANNOTATIONS, title: 'Find symbol' },
  async handler(input, context) {
    const root = context.resolveRoot(input.root);
    const graph = context.requireGraph(root);
    const query = input.query.toLowerCase();

    const matches = graph.allNodes().filter((node) => {
      if (input.kind && node.kind !== input.kind) return false;
      const selector = selectorOf(node);
      return (
        node.name.toLowerCase().includes(query) ||
        node.path.toLowerCase().includes(query) ||
        (selector !== undefined && selector.toLowerCase().includes(query))
      );
    });

    const sorted = [...matches].sort((a, b) => {
      const rankDiff = rankOf(a, query) - rankOf(b, query);
      return rankDiff !== 0 ? rankDiff : a.id.localeCompare(b.id);
    });

    const facts = sorted.map((node) =>
      makeFact({
        kind: node.kind,
        summary: symbolSummary(node),
        provenance: { file: node.path },
        confidence: 'certain',
        detail: { id: node.id, kind: node.kind, name: node.name, path: node.path, selector: selectorOf(node) },
      }),
    );

    return {
      query: input.query,
      kind: input.kind,
      matchCount: sorted.length,
      result: formatFacts(facts, {
        limit: input.limit,
        offset: input.offset,
        format: input.format,
        title: `Symbols matching "${input.query}"`,
      }),
    };
  },
});
