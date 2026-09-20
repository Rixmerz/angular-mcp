/**
 * Zod building blocks shared by every tool's input/output schema. See
 * docs/PLAN.md, section 6 and risk R7 (confidence + provenance on every fact).
 */

import { z } from 'zod';

import { DEFAULT_LIMIT } from '../../format/paginate.js';

export const NODE_KINDS = [
  'Component',
  'Directive',
  'Pipe',
  'Service',
  'NgModule',
  'Route',
  'Guard',
  'Resolver',
  'Interceptor',
  'Template',
  'Signal',
  'Observable',
  'HttpCall',
  'Spec',
  'Model',
  'Class',
  'File',
] as const;

export const nodeKindSchema = z.enum(NODE_KINDS);

export const confidenceSchema = z.enum(['certain', 'inferred', 'unknown']);

export const factProvenanceSchema = z.object({
  file: z.string().describe('Path of the file the fact was derived from, relative to the analyzed project root.'),
  line: z.number().int().optional().describe('1-based line number, when known.'),
  column: z.number().int().optional().describe('1-based column number, when known.'),
});

export const factSchema = z.object({
  kind: z.string().describe('Category of this fact, e.g. "Input", "Dependency", "HttpCall", "Route".'),
  summary: z.string().describe('Human-readable one-line description of the fact.'),
  provenance: factProvenanceSchema,
  confidence: confidenceSchema.describe(
    '"certain": derived directly from the AST/compiler. "inferred": derived through a heuristic that was not ' +
      'checked against disk (e.g. resolving a relative import specifier to a file path). "unknown": could not be ' +
      'determined at all. Never a guessed value (docs/PLAN.md risk R7).',
  ),
  detail: z.record(z.string(), z.unknown()).optional().describe('Full structured shape of the fact, for format="json".'),
});

export const paginationSchema = z.object({
  limit: z.number().int(),
  offset: z.number().int(),
  total_count: z.number().int(),
  has_more: z.boolean(),
  next_offset: z.number().int().nullable(),
});

/** Mirrors `FormattedResponse` from `src/format/index.ts`. */
export const formattedResponseSchema = z.union([
  z.object({
    format: z.literal('markdown'),
    text: z.string(),
    truncated: z.boolean(),
  }),
  z.object({
    format: z.literal('json'),
    data: z.object({
      items: z.array(factSchema).readonly(),
      pagination: paginationSchema,
    }),
  }),
]);

/** A `find_symbol` result entry, and the shape every ambiguous-ref error also carries (R13). */
export const candidateSchema = z.object({
  id: z.string().describe('Full symbol ref: "path#Name". Stable and unique across the whole indexed project (R13).'),
  kind: nodeKindSchema,
  name: z.string(),
  path: z.string(),
});

/** Common `limit`/`offset`/`format` input fields, shared by every tool that lists something (docs/PLAN.md section 6). */
export const pagingInputShape = {
  limit: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(`Max number of items to return in "result". Defaults to ${DEFAULT_LIMIT} (docs/PLAN.md risk R6).`),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Number of items in "result" to skip, for paging through a large response.'),
  format: z
    .enum(['markdown', 'json'])
    .optional()
    .describe(
      'Shape of "result": "markdown" (default) is summarized and capped at 8 KB; "json" returns the full, ' +
        'unsummarized data for programmatic use.',
    ),
} as const;

export const rootInputField = z
  .string()
  .optional()
  .describe('Root of the analyzed Angular workspace. Defaults to the project this server was started against.');
