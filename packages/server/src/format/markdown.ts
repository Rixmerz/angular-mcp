/**
 * Markdown rendering, summarized by default. See docs/PLAN.md, section 6 and
 * risk R7: every fact shows its provenance (file:line) and flags whatever was
 * inferred; the file is never omitted.
 */

import type { Page } from './paginate.js';
import { truncateMarkdown } from './truncate.js';
import type { TruncateResult } from './truncate.js';
import type { Fact } from './types.js';

export interface MarkdownOptions {
  readonly title?: string;
}

/** Renders a page of facts as markdown and applies the 8 KB cap. */
export function renderMarkdown(page: Page<Fact>, options: MarkdownOptions = {}): TruncateResult {
  const lines: string[] = [];
  if (options.title !== undefined) {
    lines.push(`## ${options.title}`, '');
  }

  if (page.items.length === 0) {
    lines.push('_No results._');
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
    return ' _(inferred)_';
  }
  if (confidence === 'unknown') {
    return ' _(unknown)_';
  }
  return '';
}

function renderPaginationFooter(page: Page<Fact>): string {
  const shown = page.items.length;
  const range = shown === 0 ? '0' : `${page.offset + 1}-${page.offset + shown}`;
  const more = page.has_more ? ` Request more with \`offset=${page.next_offset}\`.` : '';
  return `_Showing ${range} of ${page.total_count}._${more}`;
}
