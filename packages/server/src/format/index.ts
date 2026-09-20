/**
 * Formatting and pagination layer. See docs/PLAN.md, section 6 and risk R6.
 *
 * Single entry point for the MCP tools: they pass `Fact[]` (see types.ts) and
 * `formatFacts` applies limit/offset, then renders either markdown (summarized,
 * capped at 8 KB) or JSON (the full shape).
 */

import { paginate } from './paginate.js';
import type { PageParams } from './paginate.js';
import { renderMarkdown } from './markdown.js';
import { renderJson } from './json.js';
import type { JsonResponse } from './json.js';
import type { Fact } from './types.js';

export type OutputFormat = 'markdown' | 'json';

export interface FormatParams extends PageParams {
  readonly format?: OutputFormat;
  readonly title?: string;
}

export type FormattedResponse =
  | { readonly format: 'markdown'; readonly text: string; readonly truncated: boolean }
  | { readonly format: 'json'; readonly data: JsonResponse };

/** Paginates and renders `facts` according to `params.format` (markdown by default). */
export function formatFacts(facts: readonly Fact[], params: FormatParams = {}): FormattedResponse {
  const page = paginate(facts, params);

  if (params.format === 'json') {
    return { format: 'json', data: renderJson(page) };
  }

  const { text, truncated } = renderMarkdown(page, { title: params.title });
  return { format: 'markdown', text, truncated };
}

export * from './types.js';
export * from './paginate.js';
export * from './truncate.js';
export * from './markdown.js';
export * from './json.js';
