import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CACHE_SCHEMA_VERSION,
  DEFAULT_CACHE_DIR,
  GraphCache,
  diffFileHashes,
  hashContent,
  hashFile,
  isFresh,
} from '../../src/graph/cache.js';
import { ProjectGraph } from '../../src/graph/index.js';
import { makeNodeId } from '../../src/graph/model.js';
import type { ServiceNode } from '../../src/graph/model.js';

function serviceNode(path: string, name: string): ServiceNode {
  return {
    id: makeNodeId(path, name),
    kind: 'Service',
    path,
    name,
    providedIn: 'root',
    isInjectable: true,
  };
}

describe('hashContent / hashFile', () => {
  it('is deterministic for the same content', () => {
    expect(hashContent('export class UserService {}')).toBe(hashContent('export class UserService {}'));
  });

  it('differs when the content changes', () => {
    expect(hashContent('a')).not.toBe(hashContent('b'));
  });

  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'graph-cache-hashfile-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('hashes the actual bytes on disk', async () => {
    const filePath = join(dir, 'user.service.ts');
    await writeFile(filePath, 'export class UserService {}', 'utf8');

    expect(await hashFile(filePath)).toBe(hashContent('export class UserService {}'));
  });
});

describe('diffFileHashes', () => {
  it('classifies unchanged, changed, added and removed files by hash comparison', () => {
    const cached = {
      'src/app/user.service.ts': hashContent('v1'),
      'src/app/deleted.service.ts': hashContent('gone'),
    };
    const current = new Map([
      ['src/app/user.service.ts', hashContent('v2')],
      ['src/app/new.service.ts', hashContent('brand-new')],
    ]);

    const result = diffFileHashes(cached, current);

    expect(result.changed).toEqual(['src/app/user.service.ts']);
    expect(result.added).toEqual(['src/app/new.service.ts']);
    expect(result.removed).toEqual(['src/app/deleted.service.ts']);
    expect(result.unchanged).toEqual([]);
  });

  it('reports fresh when every hash matches and nothing was added or removed', () => {
    const cached = { 'src/app/user.service.ts': hashContent('v1') };
    const current = new Map([['src/app/user.service.ts', hashContent('v1')]]);

    const result = diffFileHashes(cached, current);

    expect(result.unchanged).toEqual(['src/app/user.service.ts']);
    expect(isFresh(result)).toBe(true);
  });

  it('normalizes paths before comparing, so "./x" and "x" refer to the same file', () => {
    const cached = { 'src/app/user.service.ts': hashContent('v1') };
    const current = new Map([['./src/app/user.service.ts', hashContent('v1')]]);

    const result = diffFileHashes(cached, current);

    expect(isFresh(result)).toBe(true);
  });
});

describe('GraphCache', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'graph-cache-'));
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('has no cache to read before anything was written', async () => {
    const cache = new GraphCache(projectRoot);
    expect(await cache.read()).toBeUndefined();
  });

  it('writes under "<root>/.angular-mcp/cache/graph.json" by default', () => {
    const cache = new GraphCache(projectRoot);
    expect(cache.filePath).toBe(join(projectRoot, DEFAULT_CACHE_DIR, 'graph.json'));
  });

  it('round-trips nodes, edges and file hashes through write/read', async () => {
    const cache = new GraphCache(projectRoot);
    const graph = new ProjectGraph();
    const service = serviceNode('src/app/user.service.ts', 'UserService');
    graph.addNode(service);
    const fileHashes = new Map([['src/app/user.service.ts', hashContent('v1')]]);

    await cache.write(graph, fileHashes);
    const cached = await cache.read();

    expect(cached).toBeDefined();
    expect(cached!.schemaVersion).toBe(CACHE_SCHEMA_VERSION);
    expect(cached!.nodes).toEqual([service]);
    expect(cached!.edges).toEqual([]);
    expect(cached!.fileHashes).toEqual({ 'src/app/user.service.ts': hashContent('v1') });
  });

  it('hydrates a fresh ProjectGraph from a cache entry', async () => {
    const cache = new GraphCache(projectRoot);
    const graph = new ProjectGraph();
    const service = serviceNode('src/app/user.service.ts', 'UserService');
    graph.addNode(service);
    await cache.write(graph, new Map([['src/app/user.service.ts', hashContent('v1')]]));

    const cached = await cache.read();
    const rehydrated = new ProjectGraph();
    cache.hydrate(rehydrated, cached!);

    expect(rehydrated.getNode(service.id)).toEqual(service);
  });

  it('checkStale reports the cache as fresh when nothing on disk changed', async () => {
    const cache = new GraphCache(projectRoot);
    const graph = new ProjectGraph();
    graph.addNode(serviceNode('src/app/user.service.ts', 'UserService'));
    const hash = hashContent('v1');
    await cache.write(graph, new Map([['src/app/user.service.ts', hash]]));

    const stale = await cache.checkStale(new Map([['src/app/user.service.ts', hash]]));

    expect(stale).toBeDefined();
    expect(isFresh(stale!)).toBe(true);
  });

  it('checkStale detects a file whose hash changed since it was cached', async () => {
    const cache = new GraphCache(projectRoot);
    const graph = new ProjectGraph();
    graph.addNode(serviceNode('src/app/user.service.ts', 'UserService'));
    await cache.write(graph, new Map([['src/app/user.service.ts', hashContent('v1')]]));

    const stale = await cache.checkStale(new Map([['src/app/user.service.ts', hashContent('v2')]]));

    expect(stale).toEqual({
      changed: ['src/app/user.service.ts'],
      added: [],
      removed: [],
      unchanged: [],
    });
  });

  it('checkStale returns undefined when there is no usable cache yet', async () => {
    const cache = new GraphCache(projectRoot);
    expect(await cache.checkStale(new Map())).toBeUndefined();
  });

  it('treats a cache with a mismatched schemaVersion as absent (obsolete entry)', async () => {
    const cache = new GraphCache(projectRoot);
    const graph = new ProjectGraph();
    graph.addNode(serviceNode('src/app/user.service.ts', 'UserService'));
    await cache.write(graph, new Map([['src/app/user.service.ts', hashContent('v1')]]));

    const raw = JSON.parse(await readFile(cache.filePath, 'utf8'));
    raw.schemaVersion = CACHE_SCHEMA_VERSION + 1;
    await writeFile(cache.filePath, JSON.stringify(raw), 'utf8');

    expect(await cache.read()).toBeUndefined();
    expect(await cache.checkStale(new Map())).toBeUndefined();
  });

  it('treats malformed JSON on disk as no cache, rather than throwing', async () => {
    const cache = new GraphCache(projectRoot);
    await mkdir(join(projectRoot, DEFAULT_CACHE_DIR), { recursive: true });
    await writeFile(cache.filePath, 'not json', 'utf8');

    expect(await cache.read()).toBeUndefined();
  });
});
