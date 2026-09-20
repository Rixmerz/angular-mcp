import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as angularCompiler from '@angular/compiler';
import * as typescript from 'typescript';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ProjectGraph } from '../../../src/graph/index.js';
import { makeNodeId } from '../../../src/graph/model.js';
import type { CallsHttpEdge, ComponentNode, HttpCallNode } from '../../../src/graph/model.js';
import type { EffectiveRules } from '../../../src/rules/load.js';
import { RulesFileSchema } from '../../../src/rules/schema.js';
import { checkRules } from '../../../src/rules/tools/check-rules.js';

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

const EFFECTIVE_RULES: EffectiveRules = {
  rules: RulesFileSchema.parse({
    version: 1,
    layers: { ui: { match: ['src/app/**/*.component.ts'] }, data: { match: ['src/app/**/*.service.ts'] } },
    boundaries: { ui: { may_depend_on: ['data'] }, data: { may_depend_on: [] } },
    constraints: [
      {
        id: 'services-own-http',
        description: 'Only data-layer services call HTTP.',
        forbid: { edge: 'calls_http', from_layer_not: 'data' },
      },
    ],
  }),
  layerOrigin: { ui: 'own', data: 'own' },
  warnings: [],
};

function graphWithHttpCallInComponent(): ProjectGraph {
  const graph = new ProjectGraph();
  const component = componentNode('src/app/user-list.component.ts', 'UserListComponent');
  const call = httpCallNode('src/app/user-list.component.ts', 'UserListComponent.getUsers', 'UserListComponent');
  graph.addNodes([component, call]);
  const edge: CallsHttpEdge = {
    kind: 'calls_http',
    from: component.id,
    to: call.id,
    provenance: { file: component.path, line: 5, column: 1 },
    confidence: 'certain',
  };
  graph.addEdge(edge);
  return graph;
}

describe('checkRules (dependency-injected graph/rules)', () => {
  it('checks the whole project when neither diff nor files are given', async () => {
    const result = await checkRules(
      { root: '/repo' },
      { graph: graphWithHttpCallInComponent(), effectiveRules: EFFECTIVE_RULES },
    );

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({ ruleId: 'services-own-http', suggestedPath: 'src/app/**/*.service.ts' });
  });

  it('scopes evaluation to the given file list', async () => {
    const graph = graphWithHttpCallInComponent();
    // A second, untouched file with the same violation must not be reported.
    const otherComponent = componentNode('src/app/other.component.ts', 'OtherComponent');
    const otherCall = httpCallNode('src/app/other.component.ts', 'OtherComponent.getUsers', 'OtherComponent');
    graph.addNodes([otherComponent, otherCall]);
    graph.addEdge({
      kind: 'calls_http',
      from: otherComponent.id,
      to: otherCall.id,
      provenance: { file: otherComponent.path, line: 1, column: 1 },
      confidence: 'certain',
    });

    const result = await checkRules(
      { root: '/repo', files: ['src/app/user-list.component.ts'] },
      { graph, effectiveRules: EFFECTIVE_RULES },
    );

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.file).toBe('src/app/user-list.component.ts');
  });

  it('formats violations with their suggested path in the summary', async () => {
    const result = await checkRules(
      { root: '/repo', format: 'markdown' },
      { graph: graphWithHttpCallInComponent(), effectiveRules: EFFECTIVE_RULES },
    );

    expect(result.response.format).toBe('markdown');
    if (result.response.format === 'markdown') {
      expect(result.response.text).toContain('Suggested allowed path');
    }
  });
});

describe('checkRules (end-to-end with a real indexed project)', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'check-rules-e2e-'));
    await mkdir(join(root, 'src/app'), { recursive: true });

    await writeFile(
      join(root, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'ES2022',
          moduleResolution: 'bundler',
          experimentalDecorators: true,
        },
      }),
      'utf8',
    );

    await writeFile(
      join(root, 'src/app/user-list.component.ts'),
      [
        "import { Component } from '@angular/core';",
        "import { HttpClient } from '@angular/common/http';",
        '',
        '@Component({ selector: \'app-user-list\', template: \'\' })',
        'export class UserListComponent {',
        '  constructor(private http: HttpClient) {}',
        '',
        '  load() {',
        "    return this.http.get('/api/users');",
        '  }',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );

    await writeFile(
      join(root, 'angular-mcp.rules.yaml'),
      [
        'version: 1',
        'layers:',
        '  ui: { match: ["src/app/**/*.component.ts"] }',
        '  data: { match: ["src/app/**/*.service.ts"] }',
        'boundaries:',
        '  ui: { may_depend_on: ["data"] }',
        '  data: { may_depend_on: [] }',
        'constraints:',
        '  - id: no-http-in-components',
        '    description: Components do not make direct HTTP calls.',
        '    forbid: { edge: calls_http, from: Component }',
        '',
      ].join('\n'),
      'utf8',
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('indexes the project, loads its rules file, and reports the violation with a suggested path', async () => {
    const result = await checkRules({ root }, { typescript, angularCompiler });

    expect(result.violations.some((v) => v.ruleId === 'no-http-in-components')).toBe(true);
  });
});
