/**
 * Incremental reindexing plan. See docs/PLAN.md, section 4.1: "[the Project
 * Graph] is serialized to `.angular-mcp/cache/` along with each source file's
 * hash. On startup, only the files whose hash changed are reindexed", and risk
 * R2 (the graph drifting out of sync with the code).
 *
 * This module only decides *what* to do with each file (index, reuse, drop)
 * and how to replay reused facts into a graph. It never parses code itself —
 * that stays the indexer's job (index.ts).
 */

import { diffFileHashes } from '../graph/cache.js';
import type { CacheFile } from '../graph/cache.js';
import type { ProjectGraph } from '../graph/index.js';
import { normalizeRelativePath } from '../graph/model.js';

export interface IncrementalPlan {
  /** Files with no cache entry, or whose hash no longer matches: must be (re)extracted. */
  readonly toIndex: readonly string[];
  /** Files whose hash is unchanged: their cached nodes/edges are reused as-is. */
  readonly toReuse: readonly string[];
  /** Files that were cached but no longer appear among the current ones. */
  readonly toRemove: readonly string[];
}

/**
 * Decides, for every currently known file, whether it needs (re)extraction,
 * can be reused from `cached`, or was removed. With no usable cache (first
 * run, or a `force` reindex that discards it), every current file needs
 * indexing and nothing is reused.
 */
export function planIncrementalIndex(
  cached: CacheFile | undefined,
  currentHashes: ReadonlyMap<string, string>,
): IncrementalPlan {
  if (!cached) {
    return {
      toIndex: Array.from(currentHashes.keys(), (path) => normalizeRelativePath(path)),
      toReuse: [],
      toRemove: [],
    };
  }

  const check = diffFileHashes(cached.fileHashes, currentHashes);
  return {
    toIndex: [...check.added, ...check.changed],
    toReuse: check.unchanged,
    toRemove: check.removed,
  };
}

/**
 * Replays into `graph` the nodes and edges the cache holds for
 * `filesToReuse`, leaving out anything derived from a file that needs
 * (re)indexing or that no longer exists. A node's own `path` and an edge's
 * `provenance.file` are what ties each cached fact back to the file that
 * produced it (see graph/model.ts) — no separate per-file index is kept in
 * the cache itself.
 */
export function hydrateReusedFiles(
  graph: ProjectGraph,
  cached: CacheFile,
  filesToReuse: readonly string[],
): void {
  if (filesToReuse.length === 0) return;

  const keep = new Set(filesToReuse.map((path) => normalizeRelativePath(path)));

  graph.addNodes(cached.nodes.filter((node) => keep.has(normalizeRelativePath(node.path))));
  graph.addEdges(cached.edges.filter((edge) => keep.has(normalizeRelativePath(edge.provenance.file))));
}
