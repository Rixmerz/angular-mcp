/**
 * `angular_index_project` — docs/PLAN.md, section 6, Phase 1.
 *
 * Builds (or incrementally refreshes) the project graph for a workspace and
 * stores it in the `ToolContext` so every other Phase 1 tool can query it.
 * Idempotent and incremental by file hash (P1): calling it again with the
 * same `root` only re-extracts files whose content changed, and never
 * mutates the analyzed project itself — the only write is the on-disk cache
 * under `<root>/<cacheDir>` (docs/PLAN.md section 4.1).
 */

import { z } from 'zod';

import { DEFAULT_CACHE_DIR } from '../graph/cache.js';
import { formatFacts } from '../format/index.js';
import { indexProject } from '../indexer/index.js';
import { resolveProjectDependencies } from '../indexer/resolve.js';
import { loadWorkspace } from '../indexer/workspace.js';

import { defineTool, READ_ONLY_ANNOTATIONS } from './internal/define.js';
import { InvalidInputError } from './internal/errors.js';
import { makeFact } from './internal/facts.js';
import { formattedResponseSchema, pagingInputShape, rootInputField } from './internal/schemas.js';

const inputSchema = {
  root: rootInputField,
  project: z
    .string()
    .optional()
    .describe(
      'Name of a project declared in angular.json to validate against the workspace. Purely a sanity check: the ' +
        'indexer always indexes the whole workspace regardless of this filter, so an unknown name fails fast ' +
        'instead of silently indexing something else.',
    ),
  force: z
    .boolean()
    .optional()
    .describe('Ignore the on-disk cache and re-extract every file from scratch, even when its hash is unchanged.'),
  ...pagingInputShape,
};

const outputSchema = {
  root: z.string().describe('Absolute path of the workspace that was indexed.'),
  workspaceKind: z.enum(['angular-cli', 'tsconfig-only']).describe('How the workspace was detected.'),
  project: z.string().optional().describe('Echoes the requested "project" input, when given.'),
  angularVersion: z.string().describe('Full @angular/compiler version resolved from the analyzed project (certain: read from its own node_modules, R1).'),
  angularMajor: z.number().int(),
  typescriptVersion: z.string(),
  cacheDir: z.string().describe('Cache directory, relative to "root".'),
  nodesByType: z.record(z.string(), z.number().int()).describe('Node count per kind, across the whole graph after this run.'),
  filesProcessed: z.number().int(),
  filesReindexed: z.number().int().describe('Files actually (re)extracted in this run.'),
  filesReused: z.number().int().describe('Files reused as-is from the cache because their hash was unchanged.'),
  filesRemoved: z.number().int().describe('Cached files that no longer exist and were dropped from the graph.'),
  elapsedMs: z.number().int(),
  result: formattedResponseSchema.describe(
    'Parse errors and files that failed to index in this run — always reported (certain), never hidden, and never ' +
      'fatal to the rest of the index (docs/PLAN.md risks R7 and R14).',
  ),
};

export const indexProjectTool = defineTool({
  name: 'angular_index_project',
  description:
    'Indexes (or incrementally refreshes) an Angular workspace: extracts components, directives, pipes, services, ' +
    'modules, routes, signals, template bindings, HTTP calls and specs into an in-memory project graph, cached to ' +
    'disk by file hash. Idempotent — safe to call repeatedly; only changed files are re-extracted unless "force" is ' +
    'set. Every other angular_* query tool requires this to have run first for the same "root". ' +
    'Structural counts (nodesByType, file counts) are certain facts derived straight from the AST; the Angular/' +
    'TypeScript versions are read from the analyzed project\'s own node_modules (R1), never assumed.',
  inputSchema,
  outputSchema,
  annotations: { ...READ_ONLY_ANNOTATIONS, title: 'Index project' },
  async handler(input, context) {
    const root = context.resolveRoot(input.root);
    const workspace = await loadWorkspace(root);

    if (input.project !== undefined) {
      const known = workspace.projects.map((project) => project.name);
      if (!known.includes(input.project)) {
        throw new InvalidInputError(
          `Project "${input.project}" is not declared in "${root}"'s angular.json. ` +
            `Known projects: ${known.length > 0 ? known.join(', ') : '(none found)'}. ` +
            'Fix the name, or omit "project" to index the whole workspace.',
        );
      }
    }

    const deps = resolveProjectDependencies(root);

    const result = await indexProject({
      root,
      typescript: deps.typescript,
      angularCompiler: deps.angularCompiler,
      cacheDir: context.cacheDir,
      force: input.force,
    });

    context.setState({ root, result, deps, workspace, indexedAtMs: Date.now() });

    const issues = [
      ...result.stats.parseErrors.map((error) =>
        makeFact({
          kind: 'ParseError',
          summary: `Template parse error: ${error.message}`,
          provenance: { file: error.file, line: error.line, column: error.column },
          confidence: 'certain',
          detail: { ...error },
        }),
      ),
      ...result.stats.brokenFiles.map((error) =>
        makeFact({
          kind: 'BrokenFile',
          summary: `Failed to index: ${error.message}`,
          provenance: { file: error.file },
          confidence: 'certain',
          detail: { ...error },
        }),
      ),
    ];

    return {
      root,
      workspaceKind: workspace.kind,
      project: input.project,
      angularVersion: deps.angularVersion.full,
      angularMajor: deps.angularVersion.major,
      typescriptVersion: deps.typescriptVersion,
      cacheDir: context.cacheDir ?? DEFAULT_CACHE_DIR,
      nodesByType: result.stats.nodesByType,
      filesProcessed: result.stats.filesProcessed,
      filesReindexed: result.stats.filesReindexed,
      filesReused: result.stats.filesReused,
      filesRemoved: result.stats.filesRemoved,
      elapsedMs: result.stats.elapsedMs,
      result: formatFacts(issues, {
        limit: input.limit,
        offset: input.offset,
        format: input.format,
        title: 'Index issues (parse errors and broken files)',
      }),
    };
  },
});
