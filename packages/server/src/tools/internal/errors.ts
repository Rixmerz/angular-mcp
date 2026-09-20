/**
 * Actionable errors shared by every Phase 1 tool (docs/PLAN.md, section 6:
 * "Actionable errors: what failed and what to try next").
 *
 * R13 (name ambiguity): a bare name that matches more than one indexed symbol
 * is never resolved by guessing. `AmbiguousRefError` carries the full list of
 * candidates so the caller can pick the right `path#Name` ref itself, or call
 * `angular_find_symbol` to inspect them first.
 */

import type { NodeKind } from '../../graph/model.js';

export class ToolError extends Error {}

/** Thrown when a tool needs a graph that has not been built yet for the requested root. */
export class NotIndexedError extends ToolError {
  constructor(root: string) {
    super(
      `The project at "${root}" has not been indexed in this session. ` +
        'Call `angular_index_project` first (pass the same `root` if you are not using the default one), then retry this call.',
    );
    this.name = 'NotIndexedError';
  }
}

export interface RefCandidate {
  readonly id: string;
  readonly kind: NodeKind;
  readonly name: string;
  readonly path: string;
}

/** Thrown when a ref (full id or bare name) matches nothing in the graph. */
export class RefNotFoundError extends ToolError {
  constructor(ref: string, expectedKind?: string) {
    const kindHint = expectedKind ? ` of kind "${expectedKind}"` : '';
    super(
      `No symbol${kindHint} matches "${ref}". Call \`angular_find_symbol\` with query="${ref}" to see what is ` +
        'actually indexed, then pass the exact "path#Name" ref it returns.',
    );
    this.name = 'RefNotFoundError';
  }
}

/** Thrown (R13) when a bare name matches more than one symbol: never guessed at. */
export class AmbiguousRefError extends ToolError {
  readonly candidates: readonly RefCandidate[];

  constructor(ref: string, candidates: readonly RefCandidate[]) {
    const list = candidates.map((c) => `${c.id} (${c.kind})`).join(', ');
    super(
      `"${ref}" matches ${candidates.length} indexed symbols, so none was picked automatically: ${list}. ` +
        'Pass the full ref ("path#Name") from this list, or call `angular_find_symbol` to inspect them first.',
    );
    this.name = 'AmbiguousRefError';
    this.candidates = candidates;
  }
}

/** Thrown for a malformed or self-inconsistent input that Zod's shape validation could not catch on its own. */
export class InvalidInputError extends ToolError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidInputError';
  }
}
