/**
 * `angular_get_index_status` — docs/PLAN.md, section 6, Phase 1.
 *
 * Tells the agent whether the graph built by `angular_index_project` is
 * still fresh, without re-running the indexer: it recomputes the current
 * per-file content hashes (R2) and diffs them against the cache. Read-only,
 * and safe to call even before the project was ever indexed.
 */

import { z } from 'zod';

import { GraphCache, diffFileHashes, isFresh } from '../graph/cache.js';
import { formatFacts } from '../format/index.js';
import { resolveProjectDependencies } from '../indexer/resolve.js';
import { loadWorkspace } from '../indexer/workspace.js';

import { defineTool, READ_ONLY_ANNOTATIONS } from './internal/define.js';
import { makeFact } from './internal/facts.js';
import { collectCurrentFileHashes } from './internal/hashing.js';
import { formattedResponseSchema, pagingInputShape, rootInputField } from './internal/schemas.js';

const inputSchema = {
  root: rootInputField,
  ...pagingInputShape,
};

const statusSchema = z.enum(['never_indexed', 'fresh', 'stale', 'unknown']);

const outputSchema = {
  root: z.string(),
  status: statusSchema.describe(
    '"never_indexed": angular_index_project has not run for this root in this session. "fresh": every indexed ' +
      "file's hash still matches the cache. \"stale\": at least one file was added, changed or removed since the " +
      'last index. "unknown": freshness could not be determined (e.g. the workspace or its dependencies could not ' +
      'be resolved) — never reported as "fresh" or "stale" by a guess (R7).',
  ),
  message: z.string().describe('One-line, actionable summary of the status.'),
  angularVersion: z.string().optional().describe('Detected @angular/compiler version, when it could be resolved.'),
  workspaceKind: z.enum(['angular-cli', 'tsconfig-only']).optional(),
  indexedAtIso: z.string().optional().describe('When angular_index_project last ran for this root, in this session.'),
  indexedSecondsAgo: z.number().int().optional(),
  result: formattedResponseSchema.describe('Pending files: added, changed or removed since the last index (empty when fresh).'),
};

export const getIndexStatusTool = defineTool({
  name: 'angular_get_index_status',
  description:
    'Reports whether the in-memory project graph is fresh or stale relative to the files on disk, without ' +
    'rebuilding it. Call this before relying on other angular_* tools' +
    ' after files may have changed outside this session (docs/PLAN.md risk R2). It never modifies anything.',
  inputSchema,
  outputSchema,
  annotations: { ...READ_ONLY_ANNOTATIONS, title: 'Get index status' },
  async handler(input, context) {
    const root = context.resolveRoot(input.root);
    const state = context.getStateFor(root);

    if (!state) {
      let angularVersion: string | undefined;
      try {
        angularVersion = resolveProjectDependencies(root).angularVersion.full;
      } catch {
        angularVersion = undefined;
      }

      return {
        root,
        status: 'never_indexed' as const,
        message: `"${root}" has not been indexed in this session. Call angular_index_project with root="${root}" first.`,
        angularVersion,
        result: formatFacts([], { limit: input.limit, offset: input.offset, format: input.format, title: 'Pending files' }),
      };
    }

    const cache = new GraphCache(root, context.cacheDir);
    const cached = await cache.read();

    if (!cached) {
      return {
        root,
        status: 'unknown' as const,
        message:
          'The project was indexed in this session, but its on-disk cache is missing or unreadable. ' +
          'Call angular_index_project (with force=true if needed) to rebuild it.',
        angularVersion: state.deps.angularVersion.full,
        workspaceKind: state.workspace.kind,
        indexedAtIso: new Date(state.indexedAtMs).toISOString(),
        indexedSecondsAgo: Math.floor((Date.now() - state.indexedAtMs) / 1000),
        result: formatFacts([], { limit: input.limit, offset: input.offset, format: input.format, title: 'Pending files' }),
      };
    }

    let workspace;
    try {
      workspace = await loadWorkspace(root);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        root,
        status: 'unknown' as const,
        message: `Could not re-read the workspace layout to check freshness: ${message}`,
        angularVersion: state.deps.angularVersion.full,
        workspaceKind: state.workspace.kind,
        indexedAtIso: new Date(state.indexedAtMs).toISOString(),
        indexedSecondsAgo: Math.floor((Date.now() - state.indexedAtMs) / 1000),
        result: formatFacts([], { limit: input.limit, offset: input.offset, format: input.format, title: 'Pending files' }),
      };
    }

    const { hashes: currentHashes, brokenProjects } = await collectCurrentFileHashes(state.deps.typescript, workspace);
    const check = diffFileHashes(cached.fileHashes, currentHashes);
    const fresh = isFresh(check) && brokenProjects.length === 0;

    const pendingFacts = [
      ...check.added.map((file) =>
        makeFact({ kind: 'PendingFile', summary: `Added since the last index: ${file}`, provenance: { file }, confidence: 'certain', detail: { file, reason: 'added' } }),
      ),
      ...check.changed.map((file) =>
        makeFact({ kind: 'PendingFile', summary: `Changed since the last index: ${file}`, provenance: { file }, confidence: 'certain', detail: { file, reason: 'changed' } }),
      ),
      ...check.removed.map((file) =>
        makeFact({ kind: 'PendingFile', summary: `Removed since the last index: ${file}`, provenance: { file }, confidence: 'certain', detail: { file, reason: 'removed' } }),
      ),
      ...brokenProjects.map((broken) =>
        makeFact({
          kind: 'BrokenProject',
          summary: `Could not re-check project "${broken.project}": ${broken.message}`,
          provenance: { file: broken.project },
          confidence: 'certain',
          detail: { ...broken },
        }),
      ),
    ];

    return {
      root,
      status: fresh ? ('fresh' as const) : ('stale' as const),
      message: fresh
        ? 'The index is fresh: every file matches the last indexed hash.'
        : `The index is stale: ${pendingFacts.length} file(s) changed since the last run. Call angular_index_project to refresh it.`,
      angularVersion: state.deps.angularVersion.full,
      workspaceKind: state.workspace.kind,
      indexedAtIso: new Date(state.indexedAtMs).toISOString(),
      indexedSecondsAgo: Math.floor((Date.now() - state.indexedAtMs) / 1000),
      result: formatFacts(pendingFacts, { limit: input.limit, offset: input.offset, format: input.format, title: 'Pending files' }),
    };
  },
});
