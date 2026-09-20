import { describe, expect, it } from 'vitest';

import { ProjectGraph } from '../../src/graph/index.js';
import type { CacheFile } from '../../src/graph/cache.js';
import type { ComponentNode, InjectsEdge, ServiceNode } from '../../src/graph/model.js';
import { hydrateReusedFiles, planIncrementalIndex } from '../../src/indexer/incremental.js';

const SERVICE: ServiceNode = {
  id: 'src/app/user.service.ts#UserService',
  kind: 'Service',
  path: 'src/app/user.service.ts',
  name: 'UserService',
  providedIn: 'root',
  isInjectable: true,
};

const COMPONENT: ComponentNode = {
  id: 'src/app/user-list.component.ts#UserListComponent',
  kind: 'Component',
  path: 'src/app/user-list.component.ts',
  name: 'UserListComponent',
  selector: 'app-user-list',
  standalone: true,
  changeDetection: 'Default',
  inlineTemplate: true,
  stylePaths: [],
  inputs: [],
  outputs: [],
  signals: [],
  lifecycleHooks: [],
  hostBindings: [],
};

const INJECTS_EDGE: InjectsEdge = {
  kind: 'injects',
  from: COMPONENT.id,
  to: SERVICE.id,
  provenance: { file: COMPONENT.path, line: 1, column: 1 },
  confidence: 'certain',
  via: 'inject',
  optional: false,
};

function makeCacheFile(overrides: Partial<CacheFile> = {}): CacheFile {
  return {
    schemaVersion: 1,
    generatedAt: new Date(0).toISOString(),
    fileHashes: {
      [SERVICE.path]: 'hash-service-v1',
      [COMPONENT.path]: 'hash-component-v1',
    },
    nodes: [SERVICE, COMPONENT],
    edges: [INJECTS_EDGE],
    ...overrides,
  };
}

describe('planIncrementalIndex', () => {
  it('sends every current file to toIndex when there is no cache yet', () => {
    const currentHashes = new Map([
      [SERVICE.path, 'hash-service-v1'],
      [COMPONENT.path, 'hash-component-v1'],
    ]);

    const plan = planIncrementalIndex(undefined, currentHashes);

    expect([...plan.toIndex].sort()).toEqual([COMPONENT.path, SERVICE.path].sort());
    expect(plan.toReuse).toEqual([]);
    expect(plan.toRemove).toEqual([]);
  });

  it('reuses every file whose hash is unchanged and reindexes only the ones that changed', () => {
    const cached = makeCacheFile();
    const currentHashes = new Map([
      [SERVICE.path, 'hash-service-v1'], // unchanged
      [COMPONENT.path, 'hash-component-v2'], // changed
    ]);

    const plan = planIncrementalIndex(cached, currentHashes);

    expect(plan.toIndex).toEqual([COMPONENT.path]);
    expect(plan.toReuse).toEqual([SERVICE.path]);
    expect(plan.toRemove).toEqual([]);
  });

  it('marks a brand-new file as toIndex and a deleted one as toRemove', () => {
    const cached = makeCacheFile();
    const currentHashes = new Map([
      [SERVICE.path, 'hash-service-v1'],
      ['src/app/new.service.ts', 'hash-new-v1'],
    ]);

    const plan = planIncrementalIndex(cached, currentHashes);

    expect(plan.toIndex).toEqual(['src/app/new.service.ts']);
    expect(plan.toReuse).toEqual([SERVICE.path]);
    expect(plan.toRemove).toEqual([COMPONENT.path]);
  });

  it('reports every file unchanged when nothing in the project moved', () => {
    const cached = makeCacheFile();
    const currentHashes = new Map([
      [SERVICE.path, 'hash-service-v1'],
      [COMPONENT.path, 'hash-component-v1'],
    ]);

    const plan = planIncrementalIndex(cached, currentHashes);

    expect(plan.toIndex).toEqual([]);
    expect([...plan.toReuse].sort()).toEqual([COMPONENT.path, SERVICE.path].sort());
    expect(plan.toRemove).toEqual([]);
  });
});

describe('hydrateReusedFiles', () => {
  it('loads into the graph only the nodes and edges that belong to the reused files', () => {
    const cached = makeCacheFile();
    const graph = new ProjectGraph();

    hydrateReusedFiles(graph, cached, [SERVICE.path]);

    expect(graph.hasNode(SERVICE.id)).toBe(true);
    expect(graph.hasNode(COMPONENT.id)).toBe(false);
    // The edge's provenance file is the component's, which was not reused, so it is dropped too.
    expect(graph.edgesFrom(COMPONENT.id)).toEqual([]);
  });

  it('leaves the graph untouched when no file is being reused', () => {
    const cached = makeCacheFile();
    const graph = new ProjectGraph();

    hydrateReusedFiles(graph, cached, []);

    expect(graph.nodeCount).toBe(0);
    expect(graph.edgeCount).toBe(0);
  });

  it('replays both nodes and edges when every file that produced them is reused', () => {
    const cached = makeCacheFile();
    const graph = new ProjectGraph();

    hydrateReusedFiles(graph, cached, [SERVICE.path, COMPONENT.path]);

    expect(graph.hasNode(SERVICE.id)).toBe(true);
    expect(graph.hasNode(COMPONENT.id)).toBe(true);
    expect(graph.edgesFrom(COMPONENT.id, 'injects')).toHaveLength(1);
  });
});
