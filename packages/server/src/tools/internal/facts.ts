/**
 * Small helper to build `Fact` values (src/format/types.ts) without repeating
 * the same object shape in every tool.
 */

import type { Fact, FactProvenance } from '../../format/index.js';
import type { Confidence } from '../../graph/model.js';

export function makeFact(params: {
  readonly kind: string;
  readonly summary: string;
  readonly provenance: FactProvenance;
  readonly confidence: Confidence;
  readonly detail?: Readonly<Record<string, unknown>>;
}): Fact {
  return {
    kind: params.kind,
    summary: params.summary,
    provenance: params.provenance,
    confidence: params.confidence,
    detail: params.detail,
  };
}

/** Maps an `HttpCallNode.urlConfidence` to the fact-level `Confidence` it implies (R3/R7). */
export function confidenceFromUrlConfidence(urlConfidence: 'literal' | 'template' | 'unknown'): Confidence {
  if (urlConfidence === 'literal') return 'certain';
  if (urlConfidence === 'template') return 'inferred';
  return 'unknown';
}
