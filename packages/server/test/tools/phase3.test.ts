/**
 * Tests for the Phase 3 tools (docs/PLAN.md, section 6): `angular_find_similar`,
 * `angular_get_api_contract` and `angular_list_decisions`, run against the real
 * standalone fixture.
 *
 * The contract tool is where P4 matters most: an answer read from an OpenAPI
 * document is the backend's promise and is `certain`, while one read from a
 * call site's generics is what this codebase *assumes* and must come back
 * `inferred`. Both paths are exercised, with and without a document present.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as angularCompiler from '@angular/compiler';
import * as typescript from 'typescript';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { indexProject } from '../../src/indexer/index.js';
import { ToolContext } from '../../src/tools/index.js';
import { findSimilarTool } from '../../src/tools/find_similar.js';
import { getApiContractTool, normalizeUrlForMatching, urlMatchesOpenApiPath } from '../../src/tools/get_api_contract.js';
import { listDecisionsTool } from '../../src/tools/list_decisions.js';

const FIXTURE = join(process.cwd(), '..', '..', 'fixtures', 'standalone-app');

/** Text of a formatted response, whichever shape it came back in. */
function textOf(result: { result: unknown }): string {
  const response = result.result as { format: string; text?: string; data?: unknown };
  return response.format === 'markdown' ? (response.text ?? '') : JSON.stringify(response.data);
}

async function contextForFixture(root: string): Promise<ToolContext> {
  const cacheDir = await mkdtemp(join(tmpdir(), 'phase3-cache-'));
  const deps = { typescript, angularCompiler };
  const result = await indexProject({ root, ...deps, force: true, cacheDir });

  const context = new ToolContext({ defaultRoot: root, cacheDir });
  context.setState({
    root,
    result,
    deps: {
      typescript,
      typescriptVersion: typescript.version,
      angularCompiler,
      angularVersion: { full: '18.2.14', major: 18 },
    },
    workspace: { root, kind: 'angular-cli', projects: [] },
    indexedAtMs: Date.now(),
  });

  return context;
}

describe('angular_find_similar', () => {
  let context: ToolContext;

  beforeEach(async () => {
    context = await contextForFixture(FIXTURE);
  });

  it('ranks the fixture\'s other list component above an unrelated one', async () => {
    const output = await findSimilarTool.run({ ref: 'UserListComponent' }, context);

    expect(output.candidateCount).toBeGreaterThan(0);
    const text = textOf(output);
    // OrderListComponent is the other data-backed list; both inject a service
    // that fetches over HTTP and hold signal state.
    expect(text).toContain('OrderListComponent');
  });

  it('reports how each candidate differs, in both directions', async () => {
    const output = await findSimilarTool.run({ ref: 'UserListComponent', format: 'json' }, context);

    const items = (output.result as { data: { items: readonly { detail?: Record<string, unknown> }[] } }).data.items;
    const first = items[0]?.detail as { byAspect: { onlyInTarget: string[]; onlyInCandidate: string[] }[] };

    expect(first.byAspect.length).toBeGreaterThan(0);
    // The summary names what differs; it never says which is better.
    expect(textOf(output)).not.toMatch(/\b(better|worse|should|recommend)\b/i);
  });

  it('is bounded like every other list tool (P6)', async () => {
    const output = await findSimilarTool.run({ ref: 'UserListComponent', limit: 1 }, context);

    const response = output.result as { format: string; text: string };
    expect(response.format).toBe('markdown');
    expect(output.candidateCount).toBeGreaterThanOrEqual(1);
    expect(response.text).toMatch(/Showing 1-1 of/);
  });

  it('refuses a bare name that matches more than one symbol (R13)', async () => {
    await expect(findSimilarTool.run({ ref: 'Spec' }, context)).rejects.toThrow();
  });
});

describe('angular_get_api_contract', () => {
  it('falls back to the call site generics, marked inferred, when the repo has no OpenAPI document', async () => {
    const context = await contextForFixture(FIXTURE);

    const output = await getApiContractTool.run({ url_pattern: '/users', format: 'json' }, context);

    expect(output.source).toBe('typescript-generics');
    expect(output.matchCount).toBeGreaterThan(0);

    const items = (output.result as { data: { items: readonly { confidence: string }[] } }).data.items;
    // What the frontend assumes is never reported as what the backend promises.
    expect(items.every((item) => item.confidence === 'inferred')).toBe(true);
  });

  it('reads the contract from an OpenAPI document when the repo ships one, and marks it certain', async () => {
    const root = await mkdtemp(join(tmpdir(), 'contract-fixture-'));
    try {
      await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture' }), 'utf8');
      await writeFile(
        join(root, 'openapi.json'),
        JSON.stringify({
          openapi: '3.0.0',
          paths: {
            '/users': {
              get: { responses: { '200': { description: 'A list of users' } } },
            },
          },
        }),
        'utf8',
      );

      const context = await contextForFixture(FIXTURE);
      // Point the context's default root at the repo holding the document,
      // while keeping the indexed graph: the tool reads the graph for calls
      // and the disk for the contract.
      const contractContext = new ToolContext({ defaultRoot: root });
      const state = context.getStateFor(FIXTURE)!;
      contractContext.setState({ ...state, root });

      const output = await getApiContractTool.run({ url_pattern: 'api.example.com/users', format: 'json' }, contractContext);

      expect(output.source).toBe('openapi');
      expect(output.sourcePath).toBe('openapi.json');
      const items = (output.result as { data: { items: readonly { confidence: string }[] } }).data.items;
      expect(items.some((item) => item.confidence === 'certain')).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('requires one of url_pattern or http_call_ref', async () => {
    const context = await contextForFixture(FIXTURE);

    await expect(getApiContractTool.run({}, context)).rejects.toThrow(/url_pattern.*http_call_ref/s);
  });
});

describe('URL matching against OpenAPI paths', () => {
  it('collapses template holes and path parameters to the same shape', () => {
    expect(normalizeUrlForMatching('${environment.apiUrl}/users/${id}')).toBe('/users/{}');
    expect(normalizeUrlForMatching('/users/{id}')).toBe('/users/{}');
    expect(normalizeUrlForMatching('https://api.example.com/users?page=2')).toBe('/users');
  });

  it('matches a call whose URL carries a base the document omits', () => {
    expect(urlMatchesOpenApiPath('https://api.example.com/users', '/users')).toBe(true);
    expect(urlMatchesOpenApiPath('${environment.apiUrl}/users/${id}', '/users/{id}')).toBe(true);
  });

  it('does not match a different endpoint that merely shares a suffix fragment', () => {
    expect(urlMatchesOpenApiPath('https://api.example.com/superusers', '/users')).toBe(false);
  });
});

describe('angular_list_decisions', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'decisions-'));
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture' }), 'utf8');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('returns a decision verbatim, and filters by the path it applies to', async () => {
    await writeFile(
      join(root, 'angular-mcp.rules.yaml'),
      [
        'version: 1',
        'decisions:',
        '  - id: orders-paginate-server-side',
        '    text: Orders are paginated server-side, never in the client.',
        '    applies_to: ["src/app/features/orders/**"]',
        '  - id: no-global-state',
        '    text: State lives in the component that owns it.',
      ].join('\n'),
      'utf8',
    );

    const context = await contextForFixture(FIXTURE);
    const decisionContext = new ToolContext({ defaultRoot: root });
    decisionContext.setState({ ...context.getStateFor(FIXTURE)!, root });

    const all = await listDecisionsTool.run({}, decisionContext);
    expect(all.totalDecisionCount).toBe(2);
    // The text is reported exactly as written, never summarized.
    expect(textOf(all)).toContain('Orders are paginated server-side, never in the client.');

    const scoped = await listDecisionsTool.run(
      { applies_to: 'src/app/features/orders/order-list/order-list.component.ts' },
      decisionContext,
    );
    expect(scoped.decisionCount).toBe(2);

    const elsewhere = await listDecisionsTool.run({ applies_to: 'src/app/core/services/user.service.ts' }, decisionContext);
    // Only the project-wide decision applies here.
    expect(elsewhere.decisionCount).toBe(1);
    expect(textOf(elsewhere)).toContain('no-global-state');
  });

  it('reports nothing rather than failing when the project declares no decisions', async () => {
    const context = await contextForFixture(FIXTURE);
    const decisionContext = new ToolContext({ defaultRoot: root });
    decisionContext.setState({ ...context.getStateFor(FIXTURE)!, root });

    const output = await listDecisionsTool.run({}, decisionContext);

    expect(output.totalDecisionCount).toBe(0);
    expect(output.decisionCount).toBe(0);
  });
});
