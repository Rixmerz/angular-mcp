import { describe, expect, it } from 'vitest';

import { ProjectGraph } from '../../src/graph/index.js';
import { makeNodeId } from '../../src/graph/model.js';
import type {
  CallsHttpEdge,
  ComponentNode,
  DirectiveNode,
  GraphNode,
  HttpCallNode,
  InjectsEdge,
  ServiceNode,
} from '../../src/graph/model.js';
import { evaluateRules, resolveLayerForPath } from '../../src/rules/evaluate.js';
import { RulesFileSchema } from '../../src/rules/schema.js';
import type { RulesFile } from '../../src/rules/schema.js';

function componentNode(path: string, name: string, changeDetection: 'Default' | 'OnPush' = 'OnPush'): ComponentNode {
  return {
    id: makeNodeId(path, name),
    kind: 'Component',
    path,
    name,
    standalone: true,
    changeDetection,
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
  return { id: makeNodeId(path, name), kind: 'Service', path, name, providedIn: 'root', isInjectable: true };
}

function directiveNode(path: string, name: string): DirectiveNode {
  return { id: makeNodeId(path, name), kind: 'Directive', path, name, standalone: true, inputs: [], outputs: [], hostDirectives: [] };
}

function injectsEdge(from: GraphNode, to: GraphNode): InjectsEdge {
  return {
    kind: 'injects',
    from: from.id,
    to: to.id,
    provenance: { file: from.path, line: 1, column: 1 },
    confidence: 'certain',
    via: 'constructor',
    optional: false,
  };
}

function httpCallNode(callerPath: string, name: string): HttpCallNode {
  return {
    id: makeNodeId(callerPath, name),
    kind: 'HttpCall',
    path: callerPath,
    name,
    method: 'get',
    urlPattern: '/api/x',
    urlConfidence: 'literal',
    callerRef: makeNodeId(callerPath, name.split('.')[0]!),
  };
}

function callsHttpEdge(from: GraphNode, to: HttpCallNode): CallsHttpEdge {
  return { kind: 'calls_http', from: from.id, to: to.id, provenance: { file: from.path, line: 5, column: 1 }, confidence: 'certain' };
}

const LAYERED_RULES: RulesFile = RulesFileSchema.parse({
  version: 1,
  layers: {
    ui: { match: ['src/app/**/*.component.ts'] },
    data: { match: ['src/app/**/*.service.ts'] },
    shared: { match: ['src/app/shared/**'] },
  },
  boundaries: {
    ui: { may_depend_on: ['data', 'shared'] },
    data: { may_depend_on: ['shared'] },
    shared: { may_depend_on: [] },
  },
});

describe('resolveLayerForPath', () => {
  it('returns the first layer (declaration order) whose glob matches', () => {
    expect(resolveLayerForPath(LAYERED_RULES, 'src/app/user-list.component.ts')).toBe('ui');
    expect(resolveLayerForPath(LAYERED_RULES, 'src/app/user.service.ts')).toBe('data');
  });

  it('returns undefined when no layer matches', () => {
    expect(resolveLayerForPath(LAYERED_RULES, 'src/main.ts')).toBeUndefined();
  });
});

describe('evaluateRules — boundaries', () => {
  it('does not flag an edge that follows the declared boundaries', () => {
    const graph = new ProjectGraph();
    const component = componentNode('src/app/user-list.component.ts', 'UserListComponent');
    const service = serviceNode('src/app/user.service.ts', 'UserService');
    graph.addNodes([component, service]);
    graph.addEdge(injectsEdge(component, service));

    expect(evaluateRules(graph, LAYERED_RULES)).toEqual([]);
  });

  it('flags an edge that crosses a layer boundary the other way around', () => {
    const graph = new ProjectGraph();
    const service = serviceNode('src/app/user.service.ts', 'UserService');
    const component = componentNode('src/app/user-list.component.ts', 'UserListComponent');
    graph.addNodes([service, component]);
    graph.addEdge(injectsEdge(service, component));

    const violations = evaluateRules(graph, LAYERED_RULES);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ kind: 'boundary', ruleId: 'boundary:data->ui' });
  });

  it('suggests an allowed path from a layer permitted to depend on the target layer', () => {
    const graph = new ProjectGraph();
    const sharedDirective = directiveNode('src/app/shared/highlight.directive.ts', 'HighlightDirective');
    const service = serviceNode('src/app/user.service.ts', 'UserService');
    graph.addNodes([sharedDirective, service]);
    // "shared" may not depend on "data", but "ui" may — suggest a ui glob.
    graph.addEdge(injectsEdge(sharedDirective, service));

    const violations = evaluateRules(graph, LAYERED_RULES);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.suggestedPath).toBe('src/app/**/*.component.ts');
  });

  it('does not flag an edge when either endpoint has no resolvable layer', () => {
    const graph = new ProjectGraph();
    const component = componentNode('src/app/user-list.component.ts', 'UserListComponent');
    const unresolved = serviceNode('src/main-utils.ts', 'MainUtils');
    graph.addNodes([component, unresolved]);
    graph.addEdge(injectsEdge(component, unresolved));

    expect(evaluateRules(graph, LAYERED_RULES)).toEqual([]);
  });

  it('does not flag an edge within the same layer', () => {
    const graph = new ProjectGraph();
    const a = serviceNode('src/app/a.service.ts', 'AService');
    const b = serviceNode('src/app/b.service.ts', 'BService');
    graph.addNodes([a, b]);
    graph.addEdge(injectsEdge(a, b));

    expect(evaluateRules(graph, LAYERED_RULES)).toEqual([]);
  });

  it('never treats calls_http as a boundary edge (its target lives in the caller\'s own file)', () => {
    const graph = new ProjectGraph();
    const component = componentNode('src/app/user-list.component.ts', 'UserListComponent');
    const call = httpCallNode('src/app/user-list.component.ts', 'UserListComponent.getUsers');
    graph.addNodes([component, call]);
    graph.addEdge(callsHttpEdge(component, call));

    expect(evaluateRules(graph, LAYERED_RULES)).toEqual([]);
  });
});

describe('evaluateRules — forbid constraints', () => {
  const rulesWithForbid: RulesFile = RulesFileSchema.parse({
    ...LAYERED_RULES,
    constraints: [
      { id: 'no-http-in-components', description: 'Components do not call HTTP directly.', forbid: { edge: 'calls_http', from: 'Component' } },
      { id: 'services-own-http', description: 'Only data-layer services call HTTP.', forbid: { edge: 'calls_http', from_layer_not: 'data' } },
    ],
  });

  it('flags a forbidden edge by node kind', () => {
    const graph = new ProjectGraph();
    const component = componentNode('src/app/user-list.component.ts', 'UserListComponent');
    const call = httpCallNode('src/app/user-list.component.ts', 'UserListComponent.getUsers');
    graph.addNodes([component, call]);
    graph.addEdge(callsHttpEdge(component, call));

    const violations = evaluateRules(graph, rulesWithForbid);
    const ruleIds = violations.map((v) => v.ruleId).sort();
    expect(ruleIds).toEqual(['no-http-in-components', 'services-own-http']);
  });

  it('gives a "from_layer_not" violation a suggested path pointing at the required layer', () => {
    const graph = new ProjectGraph();
    const component = componentNode('src/app/user-list.component.ts', 'UserListComponent');
    const call = httpCallNode('src/app/user-list.component.ts', 'UserListComponent.getUsers');
    graph.addNodes([component, call]);
    graph.addEdge(callsHttpEdge(component, call));

    const violations = evaluateRules(graph, rulesWithForbid);
    const servicesOwnHttp = violations.find((v) => v.ruleId === 'services-own-http');
    expect(servicesOwnHttp?.suggestedPath).toBe('src/app/**/*.service.ts');
  });

  it('does not flag a call from the required layer', () => {
    const graph = new ProjectGraph();
    const service = serviceNode('src/app/user.service.ts', 'UserService');
    const call = httpCallNode('src/app/user.service.ts', 'UserService.getUsers');
    graph.addNodes([service, call]);
    graph.addEdge(callsHttpEdge(service, call));

    expect(evaluateRules(graph, rulesWithForbid)).toEqual([]);
  });

  it('does not flag a call whose layer is unresolved (never guesses, P4)', () => {
    const graph = new ProjectGraph();
    const other = serviceNode('src/scripts/seed.ts', 'SeedScript');
    const call = httpCallNode('src/scripts/seed.ts', 'SeedScript.getUsers');
    graph.addNodes([other, call]);
    graph.addEdge(callsHttpEdge(other, call));

    const violations = evaluateRules(graph, rulesWithForbid);
    expect(violations.filter((v) => v.ruleId === 'services-own-http')).toEqual([]);
  });
});

describe('evaluateRules — require constraints', () => {
  const rulesWithRequire: RulesFile = RulesFileSchema.parse({
    version: 1,
    constraints: [
      {
        id: 'onpush-required',
        description: 'Every component uses OnPush.',
        require: { node: 'Component', attr: 'changeDetection', equals: 'OnPush' },
        severity: 'warning',
      },
    ],
  });

  it('flags a component that does not satisfy the required attribute', () => {
    const graph = new ProjectGraph();
    const component = componentNode('src/app/legacy.component.ts', 'LegacyComponent', 'Default');
    graph.addNode(component);

    const violations = evaluateRules(graph, rulesWithRequire);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ kind: 'require', ruleId: 'onpush-required', severity: 'warning' });
  });

  it('does not flag a component that already satisfies the attribute', () => {
    const graph = new ProjectGraph();
    const component = componentNode('src/app/modern.component.ts', 'ModernComponent', 'OnPush');
    graph.addNode(component);

    expect(evaluateRules(graph, rulesWithRequire)).toEqual([]);
  });
});

describe('evaluateRules — scoping options', () => {
  it('restricts boundary/forbid checks to the given edges and require checks via nodeFilter', () => {
    const graph = new ProjectGraph();
    const service = serviceNode('src/app/user.service.ts', 'UserService');
    const component = componentNode('src/app/user-list.component.ts', 'UserListComponent');
    graph.addNodes([service, component]);
    const edge = injectsEdge(service, component); // a boundary violation, if evaluated
    graph.addEdge(edge);

    const scoped = evaluateRules(graph, LAYERED_RULES, { edges: [], nodeFilter: () => false });
    expect(scoped).toEqual([]);

    const unscoped = evaluateRules(graph, LAYERED_RULES);
    expect(unscoped).toHaveLength(1);
  });
});
