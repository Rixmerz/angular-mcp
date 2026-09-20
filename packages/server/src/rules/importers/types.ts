/**
 * Shared shape returned by every importer (sheriff.ts, nx.ts). See
 * docs/PLAN.md, R10: importers only ever ADD layers/boundaries derived from a
 * tool the project already configured; they never read or write the
 * project's own `angular-mcp.rules.yaml`.
 */

import type { BoundaryDef, LayerDef } from '../schema.js';

export interface ImporterResult {
  readonly layers: Readonly<Record<string, LayerDef>>;
  readonly boundaries: Readonly<Record<string, BoundaryDef>>;
  /** Configuration the importer found but could not translate faithfully (e.g. a wildcard tag). */
  readonly warnings: readonly string[];
}
