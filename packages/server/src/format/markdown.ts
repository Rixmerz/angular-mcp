/**
 * Renderizado markdown, resumido por defecto. Ver docs/PLAN.md, seccion 6
 * y riesgo R7: cada hecho muestra su proveniencia (archivo:linea) y marca
 * lo inferido, nunca omite el archivo.
 */

import type { Page } from './paginate.js';
import { truncateMarkdown } from './truncate.js';
import type { TruncateResult } from './truncate.js';
import type { Fact } from './types.js';

export interface MarkdownOptions {
  readonly title?: string;
}

/** Renderiza una pagina de hechos en markdown y aplica el tope de 8 KB. */
export function renderMarkdown(page: Page<Fact>, options: MarkdownOptions = {}): TruncateResult {
  const lines: string[] = [];
  if (options.title !== undefined) {
    lines.push(`## ${options.title}`, '');
  }

  if (page.items.length === 0) {
    lines.push('_Sin resultados._');
  } else {
    for (const fact of page.items) {
      lines.push(renderFactLine(fact));
    }
  }

  lines.push('', renderPaginationFooter(page));
  const body = lines.join('\n');

  return truncateMarkdown(body, {
    shownCount: page.items.length,
    totalCount: page.total_count,
    nextOffset: page.next_offset,
  });
}

function renderFactLine(fact: Fact): string {
  const location = renderProvenance(fact);
  const confidenceMark = renderConfidenceMark(fact.confidence);
  return `- **${fact.kind}** ${fact.summary} — \`${location}\`${confidenceMark}`;
}

function renderProvenance(fact: Fact): string {
  const { file, line, column } = fact.provenance;
  if (line === undefined) {
    return file;
  }
  return column === undefined ? `${file}:${line}` : `${file}:${line}:${column}`;
}

function renderConfidenceMark(confidence: Fact['confidence']): string {
  if (confidence === 'inferred') {
    return ' _(inferido)_';
  }
  if (confidence === 'unknown') {
    return ' _(desconocido)_';
  }
  return '';
}

function renderPaginationFooter(page: Page<Fact>): string {
  const shown = page.items.length;
  const range = shown === 0 ? '0' : `${page.offset + 1}-${page.offset + shown}`;
  const more = page.has_more ? ` Pide mas con \`offset=${page.next_offset}\`.` : '';
  return `_Mostrando ${range} de ${page.total_count}._${more}`;
}
