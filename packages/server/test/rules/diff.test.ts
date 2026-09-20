import { describe, expect, it } from 'vitest';

import { ProjectGraph } from '../../src/graph/index.js';
import { makeNodeId } from '../../src/graph/model.js';
import type { CallsHttpEdge, ComponentNode, HttpCallNode, InjectsEdge, ServiceNode } from '../../src/graph/model.js';
import { evaluateDiff, parseUnifiedDiff } from '../../src/rules/diff.js';
import { RulesFileSchema } from '../../src/rules/schema.js';

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
  return { id: makeNodeId(path, name), kind: 'Service', path, name, providedIn: 'root', isInjectable: true };
}

function httpCallNode(callerPath: string, name: string, callerName: string): HttpCallNode {
  return {
    id: makeNodeId(callerPath, name),
    kind: 'HttpCall',
    path: callerPath,
    name,
    method: 'get',
    urlPattern: '/api/x',
    urlConfidence: 'literal',
    callerRef: makeNodeId(callerPath, callerName),
  };
}

const GIT_DIFF_NEW_HTTP_CALL = [
  'diff --git a/src/app/user-list.component.ts b/src/app/user-list.component.ts',
  'index 1111111..2222222 100644',
  '--- a/src/app/user-list.component.ts',
  '+++ b/src/app/user-list.component.ts',
  '@@ -1,4 +1,6 @@',
  ' import { Component } from \'@angular/core\';',
  '+import { HttpClient } from \'@angular/common/http\';',
  ' ',
  ' export class UserListComponent {',
  '+  constructor(private http: HttpClient) {}',
  ' }',
  '',
].join('\n');

describe('parseUnifiedDiff', () => {
  it('extracts the touched file and its added line numbers from a git diff', () => {
    const changes = parseUnifiedDiff(GIT_DIFF_NEW_HTTP_CALL);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ path: 'src/app/user-list.component.ts', status: 'modified' });
    expect(changes[0]?.addedLines).toEqual([2, 5]);
  });

  it('marks a new file (--- /dev/null) as added', () => {
    const diff = [
      'diff --git a/src/app/new.service.ts b/src/app/new.service.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/src/app/new.service.ts',
      '@@ -0,0 +1,2 @@',
      '+export class NewService {}',
      '+',
      '',
    ].join('\n');

    const changes = parseUnifiedDiff(diff);
    expect(changes).toEqual([{ path: 'src/app/new.service.ts', status: 'added', addedLines: [1, 2] }]);
  });

  it('marks a deleted file (+++ /dev/null) as deleted with no added lines', () => {
    const diff = [
      'diff --git a/src/app/old.service.ts b/src/app/old.service.ts',
      'deleted file mode 100644',
      '--- a/src/app/old.service.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-export class OldService {}',
      '-',
      '',
    ].join('\n');

    const changes = parseUnifiedDiff(diff);
    expect(changes).toEqual([{ path: 'src/app/old.service.ts', status: 'deleted', addedLines: [] }]);
  });

  it('parses a plain unified diff with no "diff --git" header', () => {
    const diff = [
      '--- a/src/app/foo.ts',
      '+++ b/src/app/foo.ts',
      '@@ -1,2 +1,3 @@',
      ' a',
      '+b',
      ' c',
      '',
    ].join('\n');

    const changes = parseUnifiedDiff(diff);
    expect(changes).toEqual([{ path: 'src/app/foo.ts', status: 'modified', addedLines: [2] }]);
  });

  it('handles several files in one diff', () => {
    const diff = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1 +1,2 @@',
      ' x',
      '+y',
      'diff --git a/b.ts b/b.ts',
      '--- a/b.ts',
      '+++ b/b.ts',
      '@@ -1 +1,2 @@',
      ' x',
      '+z',
      '',
    ].join('\n');

    const changes = parseUnifiedDiff(diff);
    expect(changes.map((c) => c.path)).toEqual(['a.ts', 'b.ts']);
    expect(changes[0]?.addedLines).toEqual([2]);
    expect(changes[1]?.addedLines).toEqual([2]);
  });
});

describe('evaluateDiff', () => {
  const rules = RulesFileSchema.parse({
    version: 1,
    layers: {
      ui: { match: ['src/app/**/*.component.ts'] },
      data: { match: ['src/app/**/*.service.ts'] },
    },
    boundaries: { ui: { may_depend_on: ['data'] }, data: { may_depend_on: [] } },
    constraints: [
      {
        id: 'services-own-http',
        description: 'Only data-layer services call HTTP.',
        forbid: { edge: 'calls_http', from_layer_not: 'data' },
      },
    ],
  });

  it('reports a violation the diff introduces, with a suggested allowed path', () => {
    const graph = new ProjectGraph();
    const component = componentNode('src/app/user-list.component.ts', 'UserListComponent');
    const call = httpCallNode('src/app/user-list.component.ts', 'UserListComponent.getUsers', 'UserListComponent');
    graph.addNodes([component, call]);
    const edge: CallsHttpEdge = {
      kind: 'calls_http',
      from: component.id,
      to: call.id,
      provenance: { file: component.path, line: 5, column: 3 },
      confidence: 'certain',
    };
    graph.addEdge(edge);

    const violations = evaluateDiff(graph, rules, GIT_DIFF_NEW_HTTP_CALL);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ ruleId: 'services-own-http', suggestedPath: 'src/app/**/*.service.ts' });
  });

  it('does not report a pre-existing violation in a file the diff does not touch', () => {
    const graph = new ProjectGraph();
    const untouchedComponent = componentNode('src/app/other.component.ts', 'OtherComponent');
    const untouchedCall = httpCallNode('src/app/other.component.ts', 'OtherComponent.getUsers', 'OtherComponent');
    graph.addNodes([untouchedComponent, untouchedCall]);
    const untouchedEdge: CallsHttpEdge = {
      kind: 'calls_http',
      from: untouchedComponent.id,
      to: untouchedCall.id,
      provenance: { file: untouchedComponent.path, line: 5, column: 3 },
      confidence: 'certain',
    };
    graph.addEdge(untouchedEdge);

    const touchedComponent = componentNode('src/app/user-list.component.ts', 'UserListComponent');
    graph.addNode(touchedComponent);

    const violations = evaluateDiff(graph, rules, GIT_DIFF_NEW_HTTP_CALL);
    expect(violations).toEqual([]);
  });

  it('does not report a boundary violation touched by the diff\'s files but not by its edges elsewhere', () => {
    const graph = new ProjectGraph();
    const component = componentNode('src/app/user-list.component.ts', 'UserListComponent');
    const service = serviceNode('src/app/user.service.ts', 'UserService');
    graph.addNodes([component, service]);
    const injects: InjectsEdge = {
      kind: 'injects',
      from: component.id,
      to: service.id,
      provenance: { file: component.path, line: 2, column: 1 },
      confidence: 'certain',
      via: 'constructor',
      optional: false,
    };
    graph.addEdge(injects);

    // The diff only touches the component; the injects edge follows the boundary anyway, so no violation.
    expect(evaluateDiff(graph, rules, GIT_DIFF_NEW_HTTP_CALL)).toEqual([]);
  });
});
