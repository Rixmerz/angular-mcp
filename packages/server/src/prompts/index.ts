/**
 * `angular_plan_change`, from docs/PLAN.md, section 6, Phase 4.
 *
 * This is the server's only opinionated piece, and it is optional: a client
 * that never reads it still gets the same facts from the same tools. It
 * encodes an order of calls, not a judgement about the code — the tools stay
 * deterministic (P2) and this prompt just keeps an agent from proposing a
 * change before it has looked at the blast radius and the rules.
 */

export const PLAN_CHANGE_PROMPT_NAME = 'angular_plan_change';

export interface PlanChangeArgs {
  /** What the user wants to change, in their own words. */
  readonly request: string;
  /** A symbol name or file path to start from, when the user named one. */
  readonly startingPoint?: string;
}

export function renderPlanChangePrompt(args: PlanChangeArgs): string {
  const startingPoint = args.startingPoint?.trim();
  const firstStep = startingPoint
    ? `1. \`angular_find_symbol\` with query="${startingPoint}". It returns candidates and never picks one for you; ` +
      'choose the exact "path#Name" ref and use that ref from here on.'
    : '1. `angular_find_symbol` to turn the names in the request into exact "path#Name" refs. It returns ' +
      'candidates and never picks one for you.';

  return [
    'Before proposing any change to this Angular project, gather the facts in this order. Each step is a tool call;',
    'do not skip one because the answer seems obvious from the file you already have open.',
    '',
    firstStep,
    '2. `angular_get_component` (or `angular_get_service`) on each ref, for its inputs, outputs, signals,',
    '   dependencies and template bindings.',
    '3. `angular_impact_of` on the refs or files you intend to touch, for the consumers and dependencies you would',
    '   affect and the specs that cover them. Widen `depth` only if the result looks too shallow to decide.',
    '4. `angular_find_symbol` again for any pattern the change should follow — an existing component that already',
    '   solves the same problem is a better guide than a fresh design.',
    '5. `angular_check_rules` with the diff you are about to propose, or with the list of files it touches.',
    '   A violation names the rule and, when the rules make one derivable, a path that would be allowed instead.',
    '',
    'Then write the plan: what changes, which files, what the blast radius is, and which specs need updating.',
    'State anything the tools reported as unknown as unknown — do not fill it in by guessing.',
    '',
    `The request: ${args.request}`,
  ].join('\n');
}
