import { describe, expect, it } from 'vitest';

import { ProjectGraph } from '../../src/graph/index.js';
import { makeNodeId } from '../../src/graph/model.js';
import type {
  ComponentNode,
  GraphEdge,
  InjectsEdge,
  RendersEdge,
  ServiceNode,
  TemplateNode,
} from '../../src/graph/model.js';

function componentNode(path: string, name: string): ComponentNode {
  return {
    id: makeNodeId(path, name),
    kind: 'Component',
    path,
    name,
    standalone: true,
    changeDetection: 'OnPush',
    inlineTemplate: false,
    stylePaths: [],
    inputs: [],
    outputs: [],
    signals: [],
    lifecycleHooks: [],
    hostBindings: [],
  };
}

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

function templateNode(path: string, name: string): TemplateNode {
  return {
    id: makeNodeId(path, name),
    kind: 'Template',
    path,
    name,
    inline: false,
    parseErrors: [],
  };
}

function injectsEdge(from: string, to: string): InjectsEdge {
  return {
    kind: 'injects',
    from,
    to,
    provenance: { file: 'src/app/user-list.component.ts', line: 10, column: 3 },
    confidence: 'certain',
    via: 'inject',
    optional: false,
  };
}

function rendersEdge(from: string, to: string): RendersEdge {
  return {
    kind: 'renders',
    from,
    to,
    provenance: { file: 'src/app/user-list.component.ts', line: 1, column: 1 },
    confidence: 'certain',
  };
}

describe('ProjectGraph nodes', () => {
  it('stores a node and returns it by id', () => {
    const graph = new ProjectGraph();
    const node = serviceNode('src/app/user.service.ts', 'UserService');

    graph.addNode(node);

    expect(graph.getNode(node.id)).toBe(node);
    expect(graph.hasNode(node.id)).toBe(true);
    expect(graph.nodeCount).toBe(1);
  });

  it('rejects a node whose id is not "path#symbol"', () => {
    const graph = new ProjectGraph();
    const node = { ...serviceNode('src/app/user.service.ts', 'UserService'), id: 'UserService' };

    expect(() => graph.addNode(node)).toThrow(/ruta#simbolo/);
  });

  it('addNode is idempotent: re-adding the same id replaces the node and its index entries', () => {
    const graph = new ProjectGraph();
    const original = serviceNode('src/app/user.service.ts', 'UserService');
    graph.addNode(original);

    const updated: ServiceNode = { ...original, providedIn: 'platform' };
    graph.addNode(updated);

    expect(graph.nodeCount).toBe(1);
    expect(graph.getNode(original.id)).toEqual(updated);
    expect(graph.nodesByFile('src/app/user.service.ts')).toEqual([updated]);
  });
});

describe('ProjectGraph indices (por tipo, por nombre, por archivo)', () => {
  it('indexes by node kind', () => {
    const graph = new ProjectGraph();
    const service = serviceNode('src/app/user.service.ts', 'UserService');
    const component = componentNode('src/app/user-list.component.ts', 'UserListComponent');
    graph.addNodes([service, component]);

    expect(graph.nodesByKind('Service')).toEqual([service]);
    expect(graph.nodesByKind('Component')).toEqual([component]);
    expect(graph.nodesByKind('Directive')).toEqual([]);
  });

  it('indexes by exact symbol name, tolerating name collisions across files (R13)', () => {
    const graph = new ProjectGraph();
    const a = componentNode('src/feature-a/user-list.component.ts', 'UserListComponent');
    const b = componentNode('src/feature-b/user-list.component.ts', 'UserListComponent');
    graph.addNodes([a, b]);

    const byName = graph.nodesByName('UserListComponent');
    expect(byName).toHaveLength(2);
    expect(byName.map((n) => n.id).sort()).toEqual([a.id, b.id].sort());
  });

  it('indexes by source file, normalizing the path', () => {
    const graph = new ProjectGraph();
    const service = serviceNode('src/app/user.service.ts', 'UserService');
    graph.addNode(service);

    expect(graph.nodesByFile('src/app/user.service.ts')).toEqual([service]);
    expect(graph.nodesByFile('./src/app/user.service.ts')).toEqual([service]);
    expect(graph.nodesByFile('src\\app\\user.service.ts')).toEqual([service]);
  });
});

describe('ProjectGraph edges', () => {
  it('resolves outgoing and incoming edges, optionally filtered by kind', () => {
    const graph = new ProjectGraph();
    const component = componentNode('src/app/user-list.component.ts', 'UserListComponent');
    const service = serviceNode('src/app/user.service.ts', 'UserService');
    const template = templateNode('src/app/user-list.component.html', 'UserListComponent');
    graph.addNodes([component, service, template]);

    const inject: GraphEdge = injectsEdge(component.id, service.id);
    const render: GraphEdge = rendersEdge(component.id, template.id);
    graph.addEdges([inject, render]);

    expect(graph.edgesFrom(component.id)).toEqual(expect.arrayContaining([inject, render]));
    expect(graph.edgesFrom(component.id, 'injects')).toEqual([inject]);
    expect(graph.edgesTo(service.id)).toEqual([inject]);
    expect(graph.edgeCount).toBe(2);
  });
});

describe('ProjectGraph.traverse', () => {
  function buildChain(): { graph: ProjectGraph; ids: string[] } {
    const graph = new ProjectGraph();
    const component = componentNode('src/app/user-list.component.ts', 'UserListComponent');
    const service = serviceNode('src/app/user.service.ts', 'UserService');
    const template = templateNode('src/app/user-list.component.html', 'UserListComponent');
    graph.addNodes([component, service, template]);
    graph.addEdges([injectsEdge(component.id, service.id), rendersEdge(component.id, template.id)]);
    return { graph, ids: [component.id, service.id, template.id] };
  }

  it('follows outgoing edges only when direction is "out"', () => {
    const { graph, ids } = buildChain();
    const [componentId, serviceId, templateId] = ids;

    const result = graph.traverse(componentId!, { direction: 'out' });

    expect(result.nodes.map((n) => n.id).sort()).toEqual([componentId, serviceId, templateId].sort());
    expect(result.depthOf.get(componentId!)).toBe(0);
    expect(result.depthOf.get(serviceId!)).toBe(1);
  });

  it('follows incoming edges only when direction is "in"', () => {
    const { graph, ids } = buildChain();
    const [componentId, serviceId] = ids;

    const result = graph.traverse(serviceId!, { direction: 'in' });

    expect(result.nodes.map((n) => n.id).sort()).toEqual([componentId, serviceId].sort());
  });

  it('follows both directions by default', () => {
    const { graph, ids } = buildChain();
    const [, serviceId] = ids;

    const result = graph.traverse(serviceId!);

    expect(result.nodes).toHaveLength(3);
  });

  it('bounds the traversal by maxDepth (P6: no unbounded walk of the whole graph)', () => {
    const { graph, ids } = buildChain();
    const [componentId, serviceId] = ids;

    const result = graph.traverse(componentId!, { direction: 'out', maxDepth: 0 });
    expect(result.nodes.map((n) => n.id)).toEqual([componentId]);

    const oneHop = graph.traverse(componentId!, { direction: 'out', maxDepth: 1 });
    expect(oneHop.nodes.map((n) => n.id).sort()).toEqual(
      [componentId, serviceId, ids[2]].sort(),
    );
  });

  it('filters by edge kind', () => {
    const { graph, ids } = buildChain();
    const [componentId, serviceId] = ids;

    const result = graph.traverse(componentId!, { direction: 'out', edgeKinds: ['injects'] });

    expect(result.nodes.map((n) => n.id).sort()).toEqual([componentId, serviceId].sort());
  });

  it('does not loop forever on a cycle', () => {
    const graph = new ProjectGraph();
    const a = serviceNode('src/app/a.service.ts', 'AService');
    const b = serviceNode('src/app/b.service.ts', 'BService');
    graph.addNodes([a, b]);
    graph.addEdges([injectsEdge(a.id, b.id), injectsEdge(b.id, a.id)]);

    const result = graph.traverse(a.id, { maxDepth: 10 });

    expect(result.nodes).toHaveLength(2);
  });

  it('returns an empty result for an unknown start id', () => {
    const graph = new ProjectGraph();
    const result = graph.traverse(makeNodeId('src/app/missing.ts', 'Missing'));
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
  });
});

describe('ProjectGraph.removeFile / removeNode', () => {
  it('removes every node derived from a file, and every edge touching them (R2)', () => {
    const graph = new ProjectGraph();
    const component = componentNode('src/app/user-list.component.ts', 'UserListComponent');
    const service = serviceNode('src/app/user.service.ts', 'UserService');
    graph.addNodes([component, service]);
    graph.addEdge(injectsEdge(component.id, service.id));

    graph.removeFile('src/app/user-list.component.ts');

    expect(graph.hasNode(component.id)).toBe(false);
    expect(graph.hasNode(service.id)).toBe(true);
    expect(graph.edgesTo(service.id)).toEqual([]);
    expect(graph.nodesByFile('src/app/user-list.component.ts')).toEqual([]);
  });

  it('removeNode drops the node from every index and every incident edge', () => {
    const graph = new ProjectGraph();
    const component = componentNode('src/app/user-list.component.ts', 'UserListComponent');
    const service = serviceNode('src/app/user.service.ts', 'UserService');
    graph.addNodes([component, service]);
    graph.addEdge(injectsEdge(component.id, service.id));

    graph.removeNode(service.id);

    expect(graph.nodesByKind('Service')).toEqual([]);
    expect(graph.nodesByName('UserService')).toEqual([]);
    expect(graph.edgesFrom(component.id)).toEqual([]);
  });
});
