/**
 * Zod schema for `angular-mcp.rules.yaml`. See docs/PLAN.md, section 5.3.
 *
 * This schema validates the SHAPE of a single rules file in isolation: field
 * types, "exactly one of forbid/require" per constraint, and unique ids.
 * Cross-references between a constraint's `from_layer_not` (or a boundary's
 * `may_depend_on`) and an actually-declared layer are deliberately NOT
 * checked here: when the project imports its layers from `sheriff` or Nx
 * (see importers/sheriff.ts, importers/nx.ts and R10 in docs/PLAN.md), a
 * layer name referenced by this file's own constraints may only exist after
 * merging with the imported layers. That merged-layer check lives in
 * `validateLayerReferences` (load.ts), applied uniformly whether the layers
 * came from this file, an import, or both.
 */

import { z } from 'zod';

import type { EdgeKind, NodeKind } from '../graph/model.js';

// ---------------------------------------------------------------------------
// Node/edge kind enums, kept in sync with graph/model.ts at compile time.
// ---------------------------------------------------------------------------

const NODE_KINDS = [
  'Component',
  'Directive',
  'Pipe',
  'Service',
  'NgModule',
  'Route',
  'Guard',
  'Resolver',
  'Interceptor',
  'Template',
  'Signal',
  'Observable',
  'HttpCall',
  'Spec',
  'Model',
  'Class',
  'File',
] as const satisfies readonly NodeKind[];

const EDGE_KINDS = [
  'declares',
  'injects',
  'provides',
  'imports',
  'renders',
  'uses_in_template',
  'binds',
  'emits',
  'routes_to',
  'child_of',
  'guarded_by',
  'resolves_with',
  'calls_http',
  'intercepted_by',
  'returns',
  'tested_by',
  'extends',
] as const satisfies readonly EdgeKind[];

/** Fails to compile if `list` is missing a member of `Full` (completeness, not just membership). */
type AssertExhaustive<Full extends string, List extends readonly string[]> = [Full] extends [List[number]]
  ? true
  : never;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _NodeKindsComplete = AssertExhaustive<NodeKind, typeof NODE_KINDS>;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _EdgeKindsComplete = AssertExhaustive<EdgeKind, typeof EDGE_KINDS>;

const NodeKindSchema = z.enum(NODE_KINDS);
const EdgeKindSchema = z.enum(EDGE_KINDS);

// ---------------------------------------------------------------------------
// Layers and boundaries
// ---------------------------------------------------------------------------

const LayerNameSchema = z.string().min(1, 'A layer name cannot be empty.');

export const LayerDefSchema = z
  .object({
    match: z
      .array(z.string().min(1, 'A layer "match" glob cannot be empty.'))
      .min(1, 'A layer must declare at least one glob under "match".'),
  })
  .strict();

export const BoundaryDefSchema = z
  .object({
    may_depend_on: z.array(LayerNameSchema).default([]),
  })
  .strict();

// ---------------------------------------------------------------------------
// Constraints
// ---------------------------------------------------------------------------

export const ForbidSchema = z
  .object({
    edge: EdgeKindSchema,
    from: NodeKindSchema.optional(),
    from_layer_not: LayerNameSchema.optional(),
  })
  .strict()
  .refine((forbid) => forbid.from !== undefined || forbid.from_layer_not !== undefined, {
    message: 'A "forbid" constraint must set "from" or "from_layer_not" to narrow which edges it targets.',
  });

export const RequireSchema = z
  .object({
    node: NodeKindSchema,
    attr: z.string().min(1, 'A "require" constraint must name a non-empty "attr".'),
    equals: z.unknown(),
  })
  .strict();

export const SeveritySchema = z.enum(['error', 'warning']);

export const ConstraintSchema = z
  .object({
    id: z.string().min(1, 'A constraint must have a non-empty "id".'),
    description: z.string().min(1, 'A constraint must have a non-empty "description".'),
    forbid: ForbidSchema.optional(),
    require: RequireSchema.optional(),
    severity: SeveritySchema.default('error'),
  })
  .strict()
  .refine((constraint) => (constraint.forbid !== undefined) !== (constraint.require !== undefined), {
    message: 'A constraint must declare exactly one of "forbid" or "require" (not both, not neither).',
  });

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

export const DecisionSchema = z
  .object({
    id: z.string().min(1, 'A decision must have a non-empty "id".'),
    text: z.string().min(1, 'A decision must have a non-empty "text".'),
    applies_to: z.array(z.string().min(1)).default([]),
  })
  .strict();

// ---------------------------------------------------------------------------
// Rules file
// ---------------------------------------------------------------------------

export const RulesFileSchema = z
  .object({
    version: z
      .number()
      .int()
      .refine((version) => version === 1, {
        message: 'Unsupported "version": only version 1 of the rules file schema is supported.',
      }),
    layers: z.record(LayerNameSchema, LayerDefSchema).default({}),
    boundaries: z.record(LayerNameSchema, BoundaryDefSchema).default({}),
    constraints: z.array(ConstraintSchema).default([]),
    decisions: z.array(DecisionSchema).default([]),
  })
  .strict()
  .superRefine((rules, ctx) => {
    const constraintIds = new Set<string>();
    rules.constraints.forEach((constraint, index) => {
      if (constraintIds.has(constraint.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['constraints', index, 'id'],
          message: `Duplicate constraint id "${constraint.id}". Constraint ids must be unique.`,
        });
      }
      constraintIds.add(constraint.id);
    });

    const decisionIds = new Set<string>();
    rules.decisions.forEach((decision, index) => {
      if (decisionIds.has(decision.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['decisions', index, 'id'],
          message: `Duplicate decision id "${decision.id}". Decision ids must be unique.`,
        });
      }
      decisionIds.add(decision.id);
    });
  });

export type RulesFile = z.infer<typeof RulesFileSchema>;
export type LayerDef = z.infer<typeof LayerDefSchema>;
export type BoundaryDef = z.infer<typeof BoundaryDefSchema>;
export type Constraint = z.infer<typeof ConstraintSchema>;
export type ForbidConstraint = z.infer<typeof ForbidSchema>;
export type RequireConstraint = z.infer<typeof RequireSchema>;
export type Decision = z.infer<typeof DecisionSchema>;
export type Severity = z.infer<typeof SeveritySchema>;

export const RULES_FILE_NAME = 'angular-mcp.rules.yaml';
