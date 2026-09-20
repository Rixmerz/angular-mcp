/**
 * `angular_who_uses` — docs/PLAN.md, section 6, Phase 1.
 *
 * Lists the direct consumers of a symbol: who imports it, injects it, uses
 * it in a template, or routes to it. Same R13 ref-resolution contract as
 * `angular_get_component`, but with no kind restriction — `ref` can name
 * any node kind.
 */

import { z } from 'zod';

import { formatFacts } from '../format/index.js';
import type { Fact } from '../format/index.js';
import type { EdgeKind } from '../graph/model.js';

import { defineTool, READ_ONLY_ANNOTATIONS } from './internal/define.js';
import { makeFact } from './internal/facts.js';
import { resolveRef } from './internal/refs.js';
import { formattedResponseSchema, pagingInputShape, rootInputField } from './internal/schemas.js';

const CONSUMER_EDGE_KINDS = ['imports', 'injects', 'uses_in_template', 'routes_to'] as const;
type ConsumerEdgeKind = (typeof CONSUMER_EDGE_KINDS)[number];

const inputSchema = {
  root: rootInputField,
  ref: z
    .string()
    .min(1)
    .describe(
      'Full ref ("path#Name"), or a bare name. A bare name that matches more than one indexed symbol throws ' +
        'instead of picking one (R13) — call angular_find_symbol to disambiguate.',
    ),
  via: z
    .enum(CONSUMER_EDGE_KINDS)
    .optional()
    .describe('Restrict to this kind of relationship. Omit to include all four (imports, injects, uses_in_template, routes_to).'),
  ...pagingInputShape,
};

const outputSchema = {
  id: z.string(),
  kind: z.string(),
  name: z.string(),
  path: z.string(),
  via: z.enum(CONSUMER_EDGE_KINDS).optional(),
  result: formattedResponseSchema.describe(
    'One fact per consumer, with the edge kind and its provenance/confidence exactly as the extractor produced ' +
      'them (docs/PLAN.md risk R7) — never re-derived or guessed here.',
  ),
};

function verbFor(kind: ConsumerEdgeKind): string {
  switch (kind) {
    case 'imports':
      return 'imports';
    case 'injects':
      return 'injects';
    case 'uses_in_template':
      return 'uses in its template';
    case 'routes_to':
      return 'routes to';
  }
}

export const whoUsesTool = defineTool({
  name: 'angular_who_uses',
  description:
    'Lists the direct consumers of a symbol: components/modules that import it, classes that inject it, templates ' +
    'that use it, and routes that route to it. Requires a full ref or an unambiguous bare name (docs/PLAN.md risk ' +
    'R13) — call angular_find_symbol first if you only know a partial name. This is a one-hop lookup; use ' +
    'angular_impact_of for the transitive, depth-bounded subgraph.',
  inputSchema,
  outputSchema,
  annotations: { ...READ_ONLY_ANNOTATIONS, title: 'Who uses' },
  async handler(input, context) {
    const root = context.resolveRoot(input.root);
    const graph = context.requireGraph(root);
    const node = resolveRef(graph, input.ref);

    const kinds: readonly EdgeKind[] = input.via ? [input.via] : CONSUMER_EDGE_KINDS;
    const facts: Fact[] = [];

    for (const kind of kinds) {
      for (const edge of graph.edgesTo(node.id, kind)) {
        const from = graph.getNode(edge.from);
        const consumerKind = kind as ConsumerEdgeKind;
        facts.push(
          makeFact({
            kind: edge.kind,
            summary: `${from?.name ?? edge.from} (${from?.kind ?? '?'}) ${verbFor(consumerKind)} this`,
            provenance: edge.provenance,
            confidence: edge.confidence,
            detail: { from: edge.from, edgeKind: edge.kind },
          }),
        );
      }
    }

    facts.sort((a, b) => a.summary.localeCompare(b.summary));

    return {
      id: node.id,
      kind: node.kind,
      name: node.name,
      path: node.path,
      via: input.via,
      result: formatFacts(facts, {
        limit: input.limit,
        offset: input.offset,
        format: input.format,
        title: `Who uses ${node.id}`,
      }),
    };
  },
});
