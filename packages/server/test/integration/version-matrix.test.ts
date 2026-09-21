/**
 * The version matrix from docs/PLAN.md section 9.4, and R1's mitigation.
 *
 * R1 is the plan's highest-rated risk: the Angular compiler API changes
 * between majors and breaks the template parser. Its mitigation is a CI matrix
 * over at least two majors. Until this file existed there was no such matrix —
 * both fixtures were Angular 18, and CI's matrix was over Node versions, which
 * is a different thing entirely.
 *
 * The sharpest difference between the two majors is the `standalone` default,
 * which flipped to `true` in Angular 19. `fixtures/v20-app` is the only place
 * the Angular-19-and-later branch of that logic runs against a real install.
 *
 * These tests are skipped when the v20 fixture has not been installed, so a
 * contributor who has not run its `npm install` sees a skip rather than a
 * confusing failure. CI installs it, so in CI they run.
 */

import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ComponentNode } from '../../src/graph/model.js';
import { indexProject } from '../../src/indexer/index.js';
import { resolveProjectDependencies } from '../../src/indexer/resolve.js';

const REPO_ROOT = join(process.cwd(), '..', '..');
const V20_ROOT = join(REPO_ROOT, 'fixtures', 'v20-app');
const V18_ROOT = join(REPO_ROOT, 'fixtures', 'standalone-app');

const v20Installed = existsSync(join(V20_ROOT, 'node_modules', '@angular', 'core'));

describe.skipIf(!v20Installed)('version matrix: Angular 20 alongside Angular 18', () => {
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), 'v20-'));
  });

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  async function indexV20() {
    // Resolved from the fixture, not from this server: that is the whole point
    // of the matrix, and of docs/adr/0001.
    const deps = resolveProjectDependencies(V20_ROOT);
    return indexProject({
      root: V20_ROOT,
      typescript: deps.typescript,
      angularCompiler: deps.angularCompiler,
      force: true,
      cacheDir,
    });
  }

  it('resolves a genuinely different major from the fixture, not the server', () => {
    const v20 = resolveProjectDependencies(V20_ROOT);
    const v18 = resolveProjectDependencies(V18_ROOT);

    expect(v20.angularVersion.major).toBe(20);
    expect(v18.angularVersion.major).toBe(18);

    // And neither is the copy this server depends on, which is what would make
    // the whole comparison vacuous.
    const serverRequire = createRequire(join(process.cwd(), 'package.json'));
    const serverVersion = (
      serverRequire('@angular/compiler/package.json') as { version: string }
    ).version;
    expect(v20.angularVersion.full).not.toBe(serverVersion);
  });

  it('treats an omitted standalone flag as true on Angular 20, and as false on 18', async () => {
    const v20 = await indexV20();

    const dashboard = v20.graph
      .nodesByKind('Component')
      .find((node) => node.name === 'DashboardComponent') as ComponentNode | undefined;

    // DashboardComponent writes no `standalone:` at all.
    expect(dashboard?.standalone).toBe(true);

    // The same omission in the Angular 18 fixture means the opposite, which is
    // exactly the bug this matrix exists to catch.
    const v18Deps = resolveProjectDependencies(join(REPO_ROOT, 'fixtures', 'ngmodule-app'));
    const v18 = await indexProject({
      root: join(REPO_ROOT, 'fixtures', 'ngmodule-app'),
      typescript: v18Deps.typescript,
      angularCompiler: v18Deps.angularCompiler,
      force: true,
      cacheDir: await mkdtemp(join(tmpdir(), 'v18-')),
    });
    const greeting = v18.graph
      .nodesByKind('Component')
      .find((node) => node.name === 'GreetingComponent') as ComponentNode | undefined;
    expect(greeting?.standalone).toBe(false);
  });

  it('honours an explicit standalone flag, whichever way the version default points', async () => {
    const result = await indexV20();

    const legacy = result.graph
      .nodesByKind('Component')
      .find((node) => node.name === 'LegacyPanelComponent') as ComponentNode | undefined;

    // Written down as false on a version whose default is true.
    expect(legacy?.standalone).toBe(false);
  });

  it("parses Angular 20's template syntax with Angular 20's parser", async () => {
    const result = await indexV20();

    // @if / @for / @empty in an inline template. A parser from an older major
    // would either fail on these or silently produce nothing.
    expect(result.stats.parseErrors).toEqual([]);

    const templates = result.graph.nodesByKind('Template');
    expect(templates.length).toBeGreaterThan(0);
  });

  it('extracts reactive primitives that do not exist before Angular 19', async () => {
    const result = await indexV20();

    const signalKinds = result.graph
      .nodesByKind('Signal')
      .filter((node) => node.path.endsWith('dashboard.component.ts'))
      .map((node) => (node as { signalKind: string }).signalKind);

    // linkedSignal shipped in Angular 19.
    expect(signalKinds).toContain('linkedSignal');
    expect(signalKinds).toContain('computed');
    expect(signalKinds).toContain('input');
  });

  it('indexes the whole fixture without a broken file', async () => {
    const result = await indexV20();

    expect(result.stats.brokenFiles).toEqual([]);
    expect(result.graph.nodesByKind('Service').map((node) => node.name)).toContain('MetricService');
    expect(result.graph.nodesByKind('HttpCall').length).toBeGreaterThan(0);
  });
});

/**
 * The matrix is only a matrix if CI actually installs the second version.
 * A skipped test is indistinguishable from a passing one in a summary line,
 * so this guards the arrangement itself rather than the behaviour.
 */
describe('the matrix is wired into CI', () => {
  it('has a CI step that installs the Angular 20 fixture', async () => {
    const workflow = await readFile(join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');

    expect(workflow).toContain('fixtures/v20-app');
    expect(workflow).toMatch(/npm install/);
  });

  it('declares a different Angular major from the other fixtures', async () => {
    const read = async (fixture: string): Promise<string> => {
      const manifest = JSON.parse(
        await readFile(join(REPO_ROOT, 'fixtures', fixture, 'package.json'), 'utf8'),
      ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      return manifest.dependencies?.['@angular/core'] ?? manifest.devDependencies?.['@angular/core'] ?? '';
    };

    const majorOf = (range: string): number => Number(/(\d+)/.exec(range)?.[1] ?? 0);

    const v20 = majorOf(await read('v20-app'));
    const standalone = majorOf(await read('standalone-app'));

    expect(v20).toBeGreaterThan(0);
    expect(standalone).toBeGreaterThan(0);
    expect(v20).not.toBe(standalone);
  });
});
