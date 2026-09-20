/**
 * `angular_list_http_calls` — docs/PLAN.md, section 6, Phase 1.
 *
 * Lists indexed HTTP calls with their URL confidence (R3), optionally
 * filtered by method, a URL substring, or the caller (Component/Service).
 * This is the basis for the future contracts layer (Phase 3).
 */

import { z } from 'zod';

import { formatFacts } from '../format/index.js';
import type { Fact } from '../format/index.js';
import type { HttpCallNode, HttpMethod } from '../graph/model.js';

import { defineTool, READ_ONLY_ANNOTATIONS } from './internal/define.js';
import { confidenceFromUrlConfidence, makeFact } from './internal/facts.js';
import { resolveRef } from './internal/refs.js';
import { formattedResponseSchema, pagingInputShape, rootInputField } from './internal/schemas.js';

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const;

const inputSchema = {
  root: rootInputField,
  method: z.enum(HTTP_METHODS).optional().describe('Only calls made with this HTTP method.'),
  url_pattern: z
    .string()
    .optional()
    .describe('Only calls whose urlPattern contains this substring (case-insensitive). Matches the literal/template/raw text, never a decoded or normalized URL.'),
  caller: z
    .string()
    .optional()
    .describe(
      'Only calls made by this Component/Service: a full ref ("path#Name") or a bare name. A bare name that ' +
        'matches more than one indexed symbol throws instead of picking one (R13).',
    ),
  ...pagingInputShape,
};

const outputSchema = {
  totalCalls: z.number().int().describe('Total indexed HTTP calls, before filtering.'),
  matchedCalls: z.number().int().describe('Calls matching the given filters, before pagination.'),
  result: formattedResponseSchema.describe(
    'One fact per HTTP call. Confidence reflects urlConfidence: "literal" -> certain, "template" -> inferred ' +
      '(every part of the URL was statically resolved, e.g. environment.*), "unknown" -> unknown (a dynamic value ' +
      'that was never invented — docs/PLAN.md risk R3).',
  ),
};

export const listHttpCallsTool = defineTool({
  name: 'angular_list_http_calls',
  description:
    'Lists HttpClient calls found in the project (get/post/put/patch/delete/head/options), with method, URL ' +
    'pattern and its confidence, request/response type text, and the calling class. Filter by "method", ' +
    '"url_pattern" (substring) or "caller". A call\'s confidence is "certain" only for a literal URL; a ' +
    'template/concatenation resolved through environment.* or a local exported constant is "inferred"; anything ' +
    'built from a runtime value is "unknown" — the URL text is never invented (docs/PLAN.md risk R3).',
  inputSchema,
  outputSchema,
  annotations: { ...READ_ONLY_ANNOTATIONS, title: 'List HTTP calls' },
  async handler(input, context) {
    const root = context.resolveRoot(input.root);
    const graph = context.requireGraph(root);

    let callerFilterId: string | undefined;
    if (input.caller !== undefined) {
      callerFilterId = resolveRef(graph, input.caller).id;
    }

    const allCalls = graph.nodesByKind('HttpCall') as HttpCallNode[];
    const urlNeedle = input.url_pattern?.toLowerCase();

    const matched = allCalls.filter((call) => {
      if (input.method && call.method !== (input.method as HttpMethod)) return false;
      if (urlNeedle && !call.urlPattern.toLowerCase().includes(urlNeedle)) return false;
      if (callerFilterId && call.callerRef !== callerFilterId) return false;
      return true;
    });

    matched.sort((a, b) => a.id.localeCompare(b.id));

    const facts: Fact[] = matched.map((call) => {
      const callEdge = graph.edgesTo(call.id, 'calls_http')[0];
      const caller = graph.getNode(call.callerRef);
      return makeFact({
        kind: 'HttpCall',
        summary: `${call.method.toUpperCase()} ${call.urlPattern} (from ${caller?.name ?? call.callerRef})`,
        provenance: callEdge?.provenance ?? { file: call.path },
        confidence: confidenceFromUrlConfidence(call.urlConfidence),
        detail: {
          id: call.id,
          method: call.method,
          urlPattern: call.urlPattern,
          urlConfidence: call.urlConfidence,
          requestTypeText: call.requestTypeText,
          responseTypeText: call.responseTypeText,
          callerRef: call.callerRef,
        },
      });
    });

    return {
      totalCalls: allCalls.length,
      matchedCalls: matched.length,
      result: formatFacts(facts, {
        limit: input.limit,
        offset: input.offset,
        format: input.format,
        title: 'HTTP calls',
      }),
    };
  },
});
