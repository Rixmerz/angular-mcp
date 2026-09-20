/**
 * Regression test for the Angular CLI's real tsconfig layout.
 *
 * Every other indexer test builds its own tsconfig, and they all happened to
 * use one that lists the sources through `include`. A real Angular app does
 * not: `angular.json` points the build target at `tsconfig.app.json`, whose
 * `files` is `["src/main.ts"]` and whose `include` is `["src/**\/*.d.ts"]`,
 * with the specs living behind a separate `tsconfig.spec.json`.
 *
 * Indexing the tsconfig's root file names against that layout yields exactly
 * one file and an empty graph. These tests pin the two properties that fix
 * requires: the file set is the program's transitive closure, and every
 * tsconfig the project declares is loaded.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import * as angularCompiler from '@angular/compiler';
import * as typescript from 'typescript';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { indexProject } from '../../src/indexer/index.js';

const FIXTURE_ROOT = join(process.cwd(), '..', '..', 'fixtures', 'standalone-app');

describe('indexProject against the Angular CLI tsconfig layout', () => {
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), 'real-layout-cache-'));
  });

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  /**
   * Uses the server's own `typescript`/`@angular/compiler` rather than
   * resolving them from the fixture: `fixtures/` is not a pnpm workspace
   * member, so its `node_modules` is neither committed nor installed in CI.
   * Resolving the compiler from the analyzed project (docs/PLAN.md 4.2, R1)
   * is what `resolve.test.ts` covers; what this file pins is the file set.
   */
  async function indexFixture() {
    return indexProject({
      root: FIXTURE_ROOT,
      typescript,
      angularCompiler,
      force: true,
      cacheDir,
    });
  }

  it('indexes the whole application, not just the single root file of tsconfig.app.json', async () => {
    const result = await indexFixture();

    // tsconfig.app.json's "files" is ["src/main.ts"]: anything above 1 proves
    // the closure is being walked, and these are the app's real components.
    const componentNames = result.graph.nodesByKind('Component').map((node) => node.name).sort();
    expect(componentNames).toContain('UserListComponent');
    expect(componentNames).toContain('OrderListComponent');
    expect(componentNames.length).toBeGreaterThan(3);
  });

  it('indexes specs, which live behind a separate tsconfig.spec.json', async () => {
    const result = await indexFixture();

    expect(result.graph.nodesByKind('Spec').length).toBeGreaterThan(0);
  });

  it('does not index anything from node_modules', async () => {
    const result = await indexFixture();

    const fromDependencies = result.graph.allNodes().filter((node) => node.path.split('/').includes('node_modules'));
    expect(fromDependencies).toEqual([]);
  });

  it('reaches services and their HTTP calls through the component graph', async () => {
    const result = await indexFixture();

    expect(result.graph.nodesByKind('Service').length).toBeGreaterThan(0);
    expect(result.graph.nodesByKind('HttpCall').length).toBeGreaterThan(0);
  });

  it('completes the plan\'s chain: every HTTP call reaches the registered interceptor', async () => {
    const result = await indexFixture();

    const interceptors = result.graph.nodesByKind('Interceptor');
    expect(interceptors.map((node) => node.name)).toEqual(['authInterceptor']);

    const httpCalls = result.graph.nodesByKind('HttpCall');
    const intercepted = result.graph.allEdges().filter((edge) => edge.kind === 'intercepted_by');
    expect(intercepted).toHaveLength(httpCalls.length);
    expect(new Set(intercepted.map((edge) => edge.to))).toEqual(new Set([interceptors[0]?.id]));
  });
});

describe('indexProject against the NgModule fixture', () => {
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), 'ngmodule-layout-cache-'));
  });

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it('resolves an interceptor registered through a barrel, which no import path can name (R16)', async () => {
    const result = await indexProject({
      root: join(process.cwd(), '..', '..', 'fixtures', 'ngmodule-app'),
      typescript,
      angularCompiler,
      force: true,
      cacheDir,
    });

    // app.module.ts registers it via `import { LoggingInterceptor } from './core'`,
    // so joining the specifier yields "src/app/core.ts#LoggingInterceptor" —
    // a node that does not exist. It resolves by name instead.
    const interceptors = result.graph.nodesByKind('Interceptor');
    expect(interceptors.map((node) => node.id)).toEqual([
      'src/app/core/interceptors/logging.interceptor.ts#LoggingInterceptor',
    ]);

    const intercepted = result.graph.allEdges().filter((edge) => edge.kind === 'intercepted_by');
    expect(intercepted).toHaveLength(1);
    expect(intercepted[0]?.to).toBe('src/app/core/interceptors/logging.interceptor.ts#LoggingInterceptor');
  });
});
