/**
 * `angular_get_service` — docs/PLAN.md, section 6, Phase 1.
 *
 * Profile of one service: who provides it, who injects it, what it injects,
 * the HTTP calls it makes, and its specs. Same R13 ref-resolution contract
 * as `angular_get_component`.
 */

import { z } from 'zod';

import { formatFacts } from '../format/index.js';
import type { Fact } from '../format/index.js';
import type { InjectsEdge, ServiceNode, SpecNode } from '../graph/model.js';

import { defineTool, READ_ONLY_ANNOTATIONS } from './internal/define.js';
import { confidenceFromUrlConfidence, makeFact } from './internal/facts.js';
import { resolveRef } from './internal/refs.js';
import { formattedResponseSchema, pagingInputShape, rootInputField } from './internal/schemas.js';

const inputSchema = {
  root: rootInputField,
  ref: z
    .string()
    .min(1)
    .describe(
      'Full service ref ("path#ServiceName"), or a bare service name. A bare name that matches more than one ' +
        'indexed service throws instead of picking one (R13) — call angular_find_symbol to disambiguate.',
    ),
  ...pagingInputShape,
};

const outputSchema = {
  id: z.string(),
  name: z.string(),
  path: z.string(),
  providedIn: z.enum(['root', 'platform', 'any', 'module', 'none']),
  isInjectable: z.boolean(),
  result: formattedResponseSchema.describe(
    'Who provides it, who injects it, what it injects, its HTTP calls, and its specs, as one paginated/formatted ' +
      'list of facts. Import-path resolutions are "inferred" unless checked against disk (docs/PLAN.md risk R7).',
  ),
};

export const getServiceTool = defineTool({
  name: 'angular_get_service',
  description:
    'Full profile of one Angular service: where it is provided, which components/services/guards inject it, what ' +
    'it in turn injects, the HTTP calls it makes (with URL confidence), and its specs. Requires a full ref or an ' +
    'unambiguous bare name (docs/PLAN.md risk R13) — call angular_find_symbol first if you only know a partial name.',
  inputSchema,
  outputSchema,
  annotations: { ...READ_ONLY_ANNOTATIONS, title: 'Get service' },
  async handler(input, context) {
    const root = context.resolveRoot(input.root);
    const graph = context.requireGraph(root);
    const service = resolveRef(graph, input.ref, 'Service') as ServiceNode;

    const facts: Fact[] = [];

    for (const edge of graph.edgesTo(service.id, 'provides')) {
      const provider = graph.getNode(edge.from);
      facts.push(
        makeFact({
          kind: 'ProvidedVia',
          summary: `provided by ${provider?.name ?? edge.from} (${provider?.kind ?? 'unknown'})`,
          provenance: edge.provenance,
          confidence: edge.confidence,
          detail: { from: edge.from },
        }),
      );
    }

    for (const edge of graph.edgesTo(service.id, 'injects') as InjectsEdge[]) {
      const consumer = graph.getNode(edge.from);
      facts.push(
        makeFact({
          kind: 'InjectedInto',
          summary: `injected into ${consumer?.name ?? edge.from} via ${edge.via}${edge.optional ? ' (optional)' : ''}`,
          provenance: edge.provenance,
          confidence: edge.confidence,
          detail: { from: edge.from, via: edge.via, optional: edge.optional },
        }),
      );
    }

    for (const edge of graph.edgesFrom(service.id, 'injects') as InjectsEdge[]) {
      const target = graph.getNode(edge.to);
      facts.push(
        makeFact({
          kind: 'Injects',
          summary: `injects ${target?.name ?? edge.to} via ${edge.via}${edge.optional ? ' (optional)' : ''}`,
          provenance: edge.provenance,
          confidence: edge.confidence,
          detail: { to: edge.to, via: edge.via, optional: edge.optional },
        }),
      );
    }

    for (const edge of graph.edgesFrom(service.id, 'calls_http')) {
      const call = graph.getNode(edge.to);
      if (!call || call.kind !== 'HttpCall') continue;
      facts.push(
        makeFact({
          kind: 'HttpCall',
          summary: `${call.method.toUpperCase()} ${call.urlPattern}`,
          provenance: edge.provenance,
          confidence: confidenceFromUrlConfidence(call.urlConfidence),
          detail: { id: call.id, method: call.method, urlPattern: call.urlPattern, urlConfidence: call.urlConfidence },
        }),
      );
    }

    for (const edge of graph.edgesFrom(service.id, 'tested_by')) {
      const spec = graph.getNode(edge.to) as SpecNode | undefined;
      facts.push(
        makeFact({
          kind: 'Spec',
          summary: `tested by ${spec?.path ?? edge.to}${spec && spec.describes.length > 0 ? ` (${spec.describes.join(', ')})` : ''}`,
          provenance: edge.provenance,
          confidence: edge.confidence,
          detail: { specId: edge.to, describes: spec?.describes },
        }),
      );
    }

    return {
      id: service.id,
      name: service.name,
      path: service.path,
      providedIn: service.providedIn,
      isInjectable: service.isInjectable,
      result: formatFacts(facts, {
        limit: input.limit,
        offset: input.offset,
        format: input.format,
        title: `Service profile: ${service.id}`,
      }),
    };
  },
});
