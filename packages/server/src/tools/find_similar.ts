/**
 * `angular_find_similar` — docs/PLAN.md, section 6, Phase 3.
 *
 * "Show me something in this codebase that already solves this shape of
 * problem." It compares structural signatures (src/patterns/signature.ts) and
 * returns candidates ordered by overlap, each with a summary of how it
 * differs.
 *
 * It ranks; it does not recommend (P2). The score is a counted ratio of
 * shared structural tokens, reproducible from the graph, and the difference
 * is stated rather than judged — the caller decides whether a candidate is
 * close enough for what it is doing.
 */

import { z } from 'zod';

import { formatFacts } from '../format/index.js';
import { SIGNATURE_ASPECTS, describeDifference, findSimilar } from '../patterns/signature.js';
import type { SignatureAspect } from '../patterns/signature.js';

import { defineTool, READ_ONLY_ANNOTATIONS } from './internal/define.js';
import { makeFact } from './internal/facts.js';
import { resolveRef } from './internal/refs.js';
import { formattedResponseSchema, pagingInputShape, rootInputField } from './internal/schemas.js';

const aspectSchema = z.enum(SIGNATURE_ASPECTS);

const inputSchema = {
  root: rootInputField,
  ref: z
    .string()
    .min(1)
    .describe('Full ref ("path#Name"), or a bare name that resolves to exactly one symbol, to find analogues of.'),
  aspect: z
    .array(aspectSchema)
    .optional()
    .describe(
      'Which facets to compare: "dependencies" (what it injects), "state" (its reactive primitives), "http" ' +
        '(the HTTP methods it reaches, directly or through one hop of injection), "template" (its binding and ' +
        'control-flow shapes). Defaults to all four.',
    ),
  min_score: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe('Drop candidates scoring below this. Defaults to 0, which returns every symbol of the same kind.'),
  ...pagingInputShape,
};

const outputSchema = {
  ref: z.string(),
  aspects: z.array(aspectSchema),
  candidateCount: z.number().int().describe('Candidates at or above min_score, before pagination.'),
  result: formattedResponseSchema.describe(
    'Symbols of the same kind, ordered by how much of their structure they share with the target. The score is ' +
      'the mean overlap across the compared aspects, and the summary states the difference — never which one is ' +
      'better (docs/PLAN.md P2).',
  ),
};

export const findSimilarTool = defineTool({
  name: 'angular_find_similar',
  description:
    'Finds symbols whose structure resembles a given one: what they inject, which reactive primitives they ' +
    'declare, which HTTP methods they reach, and what their template is made of. Use it to find the pattern a ' +
    'codebase already uses for a problem before inventing a new one. Candidates are ranked by a counted overlap ' +
    'of structural tokens and each comes with a summary of how it differs; the ranking is reproducible from the ' +
    'graph and expresses no preference.',
  inputSchema,
  outputSchema,
  annotations: { ...READ_ONLY_ANNOTATIONS, title: 'Find similar' },
  async handler(input, context) {
    const root = context.resolveRoot(input.root);
    const graph = context.requireGraph(root);
    const target = resolveRef(graph, input.ref);

    const aspects: readonly SignatureAspect[] = input.aspect ?? SIGNATURE_ASPECTS;
    const minScore = input.min_score ?? 0;

    const ranked = findSimilar(graph, target, aspects).filter((result) => result.score >= minScore);

    const facts = ranked.map((result) =>
      makeFact({
        kind: result.signature.kind,
        summary: `${result.signature.name} (${(result.score * 100).toFixed(0)}% shared) — ${describeDifference(result)}`,
        provenance: { file: result.signature.ref.split('#')[0] ?? result.signature.ref },
        confidence: 'certain',
        detail: {
          ref: result.signature.ref,
          name: result.signature.name,
          score: result.score,
          byAspect: result.byAspect,
        },
      }),
    );

    return {
      ref: target.id,
      aspects: [...aspects],
      candidateCount: ranked.length,
      result: formatFacts(facts, {
        limit: input.limit,
        offset: input.offset,
        format: input.format,
        title: `Symbols structurally similar to ${target.name}`,
      }),
    };
  },
});
