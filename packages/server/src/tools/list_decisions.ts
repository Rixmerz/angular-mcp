/**
 * `angular_list_decisions` — docs/PLAN.md, section 6, Phase 3.
 *
 * Architecture decisions declared in the project's own rules file, filtered to
 * the ones that apply to a path. Unlike a constraint, a decision is not
 * machine-checkable — it is the reasoning a team wrote down ("orders are
 * paginated server-side, never in the client") — so this tool reports it
 * verbatim and never interprets it (P2, P7).
 */

import { z } from 'zod';

import { formatFacts } from '../format/index.js';
import { normalizeRelativePath } from '../graph/model.js';
import { matchAnyGlob } from '../rules/glob.js';
import { loadEffectiveRules } from '../rules/load.js';
import { RULES_FILE_NAME } from '../rules/schema.js';

import { defineTool, READ_ONLY_ANNOTATIONS } from './internal/define.js';
import { makeFact } from './internal/facts.js';
import { formattedResponseSchema, pagingInputShape, rootInputField } from './internal/schemas.js';

const inputSchema = {
  root: rootInputField,
  applies_to: z
    .string()
    .optional()
    .describe(
      'A path, relative to root, to filter by: only decisions whose "applies_to" globs match it are returned. ' +
        'Omit it to list every decision.',
    ),
  ...pagingInputShape,
};

const outputSchema = {
  decisionCount: z.number().int().describe('Decisions matching the filter, before pagination.'),
  totalDecisionCount: z.number().int().describe('Decisions declared in the rules file, before filtering.'),
  result: formattedResponseSchema.describe(
    'Each decision\'s id, its text exactly as written, and the globs it applies to. A decision with no ' +
      '"applies_to" is project-wide and always matches.',
  ),
};

export const listDecisionsTool = defineTool({
  name: 'angular_list_decisions',
  description:
    'Lists the architecture decisions the project declares in its rules file, optionally filtered to those that ' +
    'apply to one path. A decision is prose a team wrote down, not a machine-checkable constraint — it is ' +
    'reported verbatim and never interpreted. Use it before changing an area to see what was already decided ' +
    'about it, and angular_check_rules for what can actually be enforced.',
  inputSchema,
  outputSchema,
  annotations: { ...READ_ONLY_ANNOTATIONS, title: 'List decisions' },
  async handler(input, context) {
    const root = context.resolveRoot(input.root);
    const state = context.requireIndexedState(root);

    const effective = await loadEffectiveRules(root, { typescript: state.deps.typescript });
    const decisions = effective.rules.decisions;

    const target = input.applies_to === undefined ? undefined : normalizeRelativePath(input.applies_to);
    const matching = decisions.filter((decision) => {
      if (target === undefined) return true;
      // No globs means the decision is project-wide, so it applies to every path.
      if (decision.applies_to.length === 0) return true;
      return matchAnyGlob(decision.applies_to, target);
    });

    const facts = matching.map((decision) =>
      makeFact({
        kind: 'Decision',
        summary: `**${decision.id}** — ${decision.text}`,
        provenance: { file: RULES_FILE_NAME },
        confidence: 'certain',
        detail: {
          id: decision.id,
          text: decision.text,
          applies_to: decision.applies_to,
          projectWide: decision.applies_to.length === 0,
        },
      }),
    );

    return {
      decisionCount: matching.length,
      totalDecisionCount: decisions.length,
      result: formatFacts(facts, {
        limit: input.limit,
        offset: input.offset,
        format: input.format,
        title: target === undefined ? 'Architecture decisions' : `Architecture decisions applying to "${target}"`,
      }),
    };
  },
});
