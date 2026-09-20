/**
 * On-disk cache of the ProjectGraph, under `.angular-mcp/cache/`. See
 * docs/PLAN.md, section 4.1 (R2: the graph drifts out of sync with the code).
 *
 * Principle P1: the cache is only an accelerator, never the source of truth.
 * Everything persisted here can be rederived by reindexing the code.
 * Invalidation is per-file by content hash: if a file's hash changed (or the
 * cache schema changed), the matching entry is treated as stale and dropped —
 * it is never patched by hand.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { GraphEdge, GraphNode } from './model.js';
import { normalizeRelativePath } from './model.js';
import type { ProjectGraph } from './index.js';

/** Cache schema version. Bump it whenever the shape of `CacheFile` changes. */
export const CACHE_SCHEMA_VERSION = 1;

export const DEFAULT_CACHE_DIR = '.angular-mcp/cache';
export const CACHE_FILE_NAME = 'graph.json';

/** Serialized cache contents: nodes, edges and the hash of every source file. */
export interface CacheFile {
  readonly schemaVersion: number;
  readonly generatedAt: string;
  /** Content hash of every indexed source file, keyed by normalized relative path. */
  readonly fileHashes: Readonly<Record<string, string>>;
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
}

/** Result of comparing the cached hashes against the current hashes on disk. */
export interface StaleCheck {
  /** Cached files whose hash no longer matches the current content. */
  readonly changed: readonly string[];
  /** Current files with no entry in the cache. */
  readonly added: readonly string[];
  /** Files that were cached but no longer appear among the current ones. */
  readonly removed: readonly string[];
  /** Files whose hash matches: safe to reuse from the cache. */
  readonly unchanged: readonly string[];
}

/** true when there is no difference at all: the cache is fully up to date. */
export function isFresh(check: StaleCheck): boolean {
  return check.changed.length === 0 && check.added.length === 0 && check.removed.length === 0;
}

/** Content hash, used both for files on disk and in tests. */
export function hashContent(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Hash of the current content of a file on disk. */
export async function hashFile(absolutePath: string): Promise<string> {
  const content = await readFile(absolutePath);
  return hashContent(content);
}

/**
 * Compares the hashes stored in a cache against the current hashes of the
 * project files. Pure: it never touches disk, so it is trivial to test without
 * filesystem fixtures.
 */
export function diffFileHashes(
  cachedHashes: Readonly<Record<string, string>>,
  currentHashes: ReadonlyMap<string, string>,
): StaleCheck {
  const changed: string[] = [];
  const added: string[] = [];
  const unchanged: string[] = [];
  const seen = new Set<string>();

  for (const [rawPath, currentHash] of currentHashes) {
    const path = normalizeRelativePath(rawPath);
    seen.add(path);
    const cachedHash = cachedHashes[path];
    if (cachedHash === undefined) {
      added.push(path);
    } else if (cachedHash !== currentHash) {
      changed.push(path);
    } else {
      unchanged.push(path);
    }
  }

  const removed: string[] = [];
  for (const path of Object.keys(cachedHashes)) {
    if (!seen.has(path)) removed.push(path);
  }

  return { changed, added, removed, unchanged };
}

function isCacheFile(value: unknown): value is CacheFile {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.schemaVersion === 'number' &&
    typeof candidate.generatedAt === 'string' &&
    typeof candidate.fileHashes === 'object' &&
    candidate.fileHashes !== null &&
    Array.isArray(candidate.nodes) &&
    Array.isArray(candidate.edges)
  );
}

/**
 * Reads and writes a `ProjectGraph` cache at `<projectRoot>/<cacheDir>/graph.json`.
 */
export class GraphCache {
  private readonly cacheFilePath: string;

  constructor(projectRoot: string, cacheDir: string = DEFAULT_CACHE_DIR) {
    this.cacheFilePath = join(projectRoot, cacheDir, CACHE_FILE_NAME);
  }

  get filePath(): string {
    return this.cacheFilePath;
  }

  /**
   * Reads the cache from disk. Returns `undefined` if it does not exist, if the
   * JSON is invalid, or if its `schemaVersion` does not match the current one:
   * a cache written under an older schema is treated as missing and is never
   * migrated by hand (P1).
   */
  async read(): Promise<CacheFile | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.cacheFilePath, 'utf8');
    } catch {
      return undefined;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return undefined;
    }

    if (!isCacheFile(parsed) || parsed.schemaVersion !== CACHE_SCHEMA_VERSION) {
      return undefined;
    }

    return parsed;
  }

  /** Serializes the whole graph together with the hash of every indexed file. */
  async write(graph: ProjectGraph, fileHashes: ReadonlyMap<string, string>): Promise<void> {
    const data: CacheFile = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      fileHashes: Object.fromEntries(
        Array.from(fileHashes, ([path, hash]) => [normalizeRelativePath(path), hash] as const),
      ),
      nodes: graph.allNodes(),
      edges: graph.allEdges(),
    };

    await mkdir(dirname(this.cacheFilePath), { recursive: true });
    await writeFile(this.cacheFilePath, JSON.stringify(data), 'utf8');
  }

  /** Reads the cache and compares it against the current hashes. `undefined` when no usable cache exists. */
  async checkStale(currentHashes: ReadonlyMap<string, string>): Promise<StaleCheck | undefined> {
    const cached = await this.read();
    if (!cached) return undefined;
    return diffFileHashes(cached.fileHashes, currentHashes);
  }

  /** Loads the nodes and edges of a cache entry into a `ProjectGraph`. */
  hydrate(graph: ProjectGraph, cached: CacheFile): void {
    graph.addNodes(cached.nodes);
    graph.addEdges(cached.edges);
  }
}
