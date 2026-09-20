/**
 * Size cap for markdown responses. See docs/PLAN.md, section 6 and risk R6:
 * "8 KB cap by default", so that a large response does not recreate the very
 * context problem this server exists to solve.
 *
 * It applies to markdown only: JSON is the full shape, "only on request"
 * (section 6), and is never truncated here.
 */

export const MAX_MARKDOWN_BYTES = 8 * 1024;

export interface TruncateContext {
  /** How many items the rendered text contained before truncation. */
  readonly shownCount: number;
  /** Total number of available items (before truncation), not just this page's. */
  readonly totalCount: number;
  /** The pagination `next_offset` if more pages exist; null otherwise. */
  readonly nextOffset: number | null;
}

export interface TruncateResult {
  readonly text: string;
  readonly truncated: boolean;
}

/**
 * Truncates `text` to `maxBytes` (8 KB by default) when needed, leaving room
 * for a notice that states the truncation and explains how to request the rest.
 */
export function truncateMarkdown(
  text: string,
  context: TruncateContext,
  maxBytes: number = MAX_MARKDOWN_BYTES,
): TruncateResult {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) {
    return { text, truncated: false };
  }

  const notice = buildTruncationNotice(context, maxBytes);
  const budget = Math.max(0, maxBytes - Buffer.byteLength(notice, 'utf8'));
  const body = cutToByteBudget(text, budget);

  return { text: `${body}${notice}`, truncated: true };
}

function buildTruncationNotice(context: TruncateContext, maxBytes: number): string {
  const remaining = Math.max(0, context.totalCount - context.shownCount);
  const howToContinue =
    context.nextOffset !== null
      ? `Request the rest with \`offset=${context.nextOffset}\` (or lower \`limit\`).`
      : 'Narrow the query, or use `format: "json"` to get the full, unsummarized shape.';

  return (
    `\n\n> Response truncated to ${Math.round(maxBytes / 1024)} KB: ` +
    `showing ${context.shownCount} of ${context.totalCount} items ` +
    `(${remaining} not shown in this block). ${howToContinue}`
  );
}

/** Cuts `text` down to at most `maxBytes` in UTF-8, without splitting a character or a line. */
function cutToByteBudget(text: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return '';
  }
  const buf = Buffer.from(text, 'utf8');
  if (buf.byteLength <= maxBytes) {
    return text;
  }

  let sliceStr = buf.subarray(0, maxBytes).toString('utf8').replace(/�+$/u, '');

  const lastNewline = sliceStr.lastIndexOf('\n');
  if (lastNewline > 0) {
    sliceStr = sliceStr.slice(0, lastNewline);
  }
  return sliceStr;
}
