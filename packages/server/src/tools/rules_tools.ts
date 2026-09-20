/**
 * The three Phase 2 rules tools, wrapped in the same `defineTool` shape as
 * every Phase 1 tool (docs/PLAN.md, section 6).
 *
 * `src/rules/tools/` exports them as plain functions because that directory
 * was written while `src/tools/` belonged to a different task. Wrapping them
 * here gives each one a Zod input schema, an `outputSchema` and the shared
 * read-only annotations, so `server.ts` registers all thirteen tools through
 * one code path instead of special-casing three of them.
 */

import { z } from 'zod';

import { checkRules } from '../rules/tools/check-rules.js';
import { explainLayer } from '../rules/tools/explain-layer.js';
import { listRules } from '../rules/tools/list-rules.js';

import { defineTool, READ_ONLY_ANNOTATIONS } from './internal/define.js';
import { formattedResponseSchema, pagingInputShape, rootInputField } from './internal/schemas.js';
import { DEFAULT_LIMIT } from '../format/paginate.js';

const ruleOriginSchema = z
  .enum(['own', 'sheriff', 'nx'])
  .describe('Where the layer came from: the project\'s own rules file, an imported sheriff config, or an Nx tag (R10).');

const violationSchema = z.object({
  kind: z.string().describe('"boundary", "forbid" or "require".'),
  ruleId: z.string(),
  severity: z.enum(['error', 'warning']),
  message: z.string(),
  file: z.string(),
  line: z.number().int().optional(),
  suggestedPath: z
    .string()
    .optional()
    .describe('A glob from a layer that IS allowed to hold this dependency, when the rules make one derivable.'),
});

export const checkRulesTool = defineTool({
  name: 'angular_check_rules',
  description:
    'Evaluates the project\'s architecture rules against a unified diff, an explicit list of files, or the whole ' +
    'project when neither is given, and reports every violation with its file, line, the rule it breaks and — when ' +
    'the rules make one derivable — a suggested allowed path. Rules are read from the project\'s own versioned ' +
    'rules file, and existing sheriff or Nx boundary config is imported rather than duplicated (docs/PLAN.md P7, R10). ' +
    'Call this before proposing a change that moves a dependency across layers.',
  inputSchema: {
    root: rootInputField,
    diff: z
      .string()
      .optional()
      .describe('A unified diff, as produced by `git diff`. Takes precedence over "files" when both are given.'),
    files: z
      .array(z.string().min(1))
      .optional()
      .describe('Paths, relative to root, to restrict the check to. Ignored when "diff" is given.'),
    ...pagingInputShape,
  },
  outputSchema: {
    violationCount: z.number().int().describe('Total number of violations, before pagination.'),
    errorCount: z.number().int().describe('How many of the violations have severity "error", before pagination.'),
    violations: z
      .array(violationSchema)
      .describe(
        'The same page of violations "result" shows, in structured form — bounded by "limit"/"offset" like every ' +
          'other list (docs/PLAN.md P6, R6). "violationCount" is the untruncated total; page through for the rest.',
      ),
    result: formattedResponseSchema,
  },
  annotations: { ...READ_ONLY_ANNOTATIONS, title: 'Check rules' },
  async handler(input, context) {
    const root = context.resolveRoot(input.root);
    const state = context.getStateFor(root);

    const { violations, response } = await checkRules(
      { root, diff: input.diff, files: input.files, limit: input.limit, offset: input.offset, format: input.format },
      {
        typescript: state?.deps.typescript,
        angularCompiler: state?.deps.angularCompiler,
        graph: state?.result.graph,
      },
    );

    // The structured array is paginated the same way the formatted response
    // is: returning every violation of a large project beside an 8 KB summary
    // would put the unbounded payload straight back into the caller's context.
    const offset = input.offset ?? 0;
    const limit = input.limit ?? DEFAULT_LIMIT;
    const page = violations.slice(offset, offset + limit);

    return {
      violationCount: violations.length,
      errorCount: violations.filter((violation) => violation.severity === 'error').length,
      violations: page.map((violation) => ({
        kind: violation.kind,
        ruleId: violation.ruleId,
        severity: violation.severity,
        message: violation.message,
        file: violation.file,
        line: violation.line,
        suggestedPath: violation.suggestedPath,
      })),
      result: response,
    };
  },
});

export const listRulesTool = defineTool({
  name: 'angular_list_rules',
  description:
    'Lists the architecture rules in effect for the project — layers and their globs, allowed dependencies between ' +
    'them, and the named constraints — together with where each layer came from (the project\'s own rules file, an ' +
    'imported sheriff config, or Nx tags). Use it to see what angular_check_rules will enforce before running it.',
  inputSchema: {
    root: rootInputField,
    ...pagingInputShape,
  },
  outputSchema: {
    layerCount: z.number().int(),
    constraintCount: z.number().int(),
    layerOrigin: z.record(z.string(), ruleOriginSchema),
    warnings: z
      .array(z.string())
      .describe('Problems found while loading the rules that did not prevent them being used, e.g. a layer nothing matches.'),
    result: formattedResponseSchema,
  },
  annotations: { ...READ_ONLY_ANNOTATIONS, title: 'List rules' },
  async handler(input, context) {
    const root = context.resolveRoot(input.root);
    const state = context.requireIndexedState(root);

    const { rules, layerOrigin, warnings, response } = await listRules(
      { root, limit: input.limit, offset: input.offset, format: input.format },
      { typescript: state.deps.typescript },
    );

    return {
      layerCount: Object.keys(rules.layers ?? {}).length,
      constraintCount: (rules.constraints ?? []).length,
      layerOrigin: { ...layerOrigin },
      warnings: [...warnings],
      result: response,
    };
  },
});

export const explainLayerTool = defineTool({
  name: 'angular_explain_layer',
  description:
    'Explains which architecture layer a single file belongs to, which glob matched it, where that layer was ' +
    'defined, and what it is allowed to depend on. Use it when angular_check_rules reports a violation and you need ' +
    'to know why that file is in that layer.',
  inputSchema: {
    root: rootInputField,
    file: z.string().min(1).describe('Path of the file to explain, relative to root.'),
  },
  outputSchema: {
    file: z.string(),
    layer: z.string().optional().describe('Absent when no layer glob matches the file — which is stated, never guessed (P4).'),
    origin: ruleOriginSchema.optional(),
    matchedGlob: z.string().optional(),
    mayDependOn: z.array(z.string()),
    reason: z.string().describe('Why the file resolved to that layer, or why it resolved to none.'),
  },
  annotations: { ...READ_ONLY_ANNOTATIONS, title: 'Explain layer' },
  async handler(input, context) {
    const root = context.resolveRoot(input.root);
    const state = context.requireIndexedState(root);

    const explained = await explainLayer({ root, file: input.file }, { typescript: state.deps.typescript });

    return {
      file: explained.file,
      layer: explained.layer,
      origin: explained.origin,
      matchedGlob: explained.matchedGlob,
      mayDependOn: [...explained.mayDependOn],
      reason: explained.reason,
    };
  },
});

/** The three Phase 2 tools, in the order they appear in docs/PLAN.md section 6. */
export const PHASE_2_TOOLS = [listRulesTool, checkRulesTool, explainLayerTool] as const;
