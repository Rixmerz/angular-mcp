/**
 * Capa de formato y paginacion. Ver docs/PLAN.md, seccion 6 y riesgo R6.
 *
 * Punto de entrada unico para las herramientas MCP: reciben `Fact[]` (ver
 * types.ts) y `formatFacts` aplica limit/offset, y renderiza en markdown
 * (resumido, con tope de 8 KB) o JSON (forma completa).
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

/** Pagina y renderiza `facts` segun `params.format` (markdown por defecto). */
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
