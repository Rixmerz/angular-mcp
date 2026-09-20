/**
 * Types for the formatting layer. See docs/PLAN.md, section 6 and risk R6.
 *
 * MCP tools do not format their graph nodes/edges directly: they reduce them to
 * `Fact[]`, the common shape this layer paginates, renders and truncates. That
 * keeps the pagination/truncation logic independent of each tool.
 */

import type { Confidence } from '../graph/model.js';

/**
 * Provenance of a rendered fact. `line`/`column` are optional because some
 * facts (a File node, for example) only have a file, but `file` is never
 * omitted (R7: never omit the file).
 */
export interface FactProvenance {
  readonly file: string;
  readonly line?: number;
  readonly column?: number;
}

/**
 * A single fact ready to render: the human-readable summary, where it came from
 * and how certain it is. `detail` carries the full shape for the JSON format;
 * `markdown.ts` ignores it.
 */
export interface Fact {
  readonly kind: string;
  readonly summary: string;
  readonly provenance: FactProvenance;
  readonly confidence: Confidence;
  readonly detail?: Readonly<Record<string, unknown>>;
}
