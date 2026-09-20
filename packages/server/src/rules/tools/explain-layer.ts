/**
 * `angular_explain_layer`: which layer a file belongs to, why (the matching
 * glob and its origin), and what it may depend on. See docs/PLAN.md,
 * section 6, Phase 2.
 */

import type * as TS from 'typescript';

import { normalizeRelativePath } from '../../graph/model.js';
import { matchGlob } from '../glob.js';
import { resolveLayerForPath } from '../evaluate.js';
import type { EffectiveRules, RuleOrigin } from '../load.js';
import { loadEffectiveRules } from '../load.js';

export interface ExplainLayerInput {
  readonly root: string;
  readonly file: string;
}

export interface ExplainLayerToolDeps {
  readonly typescript: typeof TS;
  /** Reuses already-loaded effective rules instead of reading them from disk again. */
  readonly effectiveRules?: EffectiveRules;
}

export interface ExplainLayerResult {
  readonly file: string;
  readonly layer?: string;
  readonly origin?: RuleOrigin;
  /** The glob (from `layers[layer].match`) that matched `file`. */
  readonly matchedGlob?: string;
  readonly mayDependOn: readonly string[];
  readonly reason: string;
}

/** Explains which layer `input.file` belongs to and what it is allowed to depend on. */
export async function explainLayer(input: ExplainLayerInput, deps: ExplainLayerToolDeps): Promise<ExplainLayerResult> {
  const effective = deps.effectiveRules ?? (await loadEffectiveRules(input.root, { typescript: deps.typescript }));
  const file = normalizeRelativePath(input.file);
  const layer = resolveLayerForPath(effective.rules, file);

  if (!layer) {
    const declared = Object.keys(effective.rules.layers);
    return {
      file,
      mayDependOn: [],
      reason:
        `No layer's "match" glob matches "${file}". ` +
        `Declared layers: ${declared.length > 0 ? declared.join(', ') : '(none)'}.`,
    };
  }

  const matchedGlob = effective.rules.layers[layer]?.match.find((glob) => matchGlob(glob, file));
  const origin = effective.layerOrigin[layer];
  const mayDependOn = effective.rules.boundaries[layer]?.may_depend_on ?? [];

  return {
    file,
    layer,
    origin,
    matchedGlob,
    mayDependOn,
    reason: `Matches layer "${layer}" via glob "${matchedGlob}"${origin ? ` (from ${origin})` : ''}.`,
  };
}
