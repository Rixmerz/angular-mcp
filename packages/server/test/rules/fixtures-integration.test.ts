/**
 * Integration test for the Phase 2 exit criterion (docs/PLAN.md, section 7):
 * "angular_check_rules detects 100% of the violations planted in the
 * fixtures, with no false positives."
 *
 * `fixtures/standalone-app/.../order-detail.component.ts` carries an explicit
 * "PLANTED VIOLATION" comment (see docs/PLAN.md, section 9.3): a component
 * that calls `HttpClient` directly instead of going through `OrderService`.
 * This test evaluates a realistic layered rules file against the REAL
 * indexed graph of both fixture apps and checks both halves of the exit
 * criterion at once: the planted violation IS detected (with a suggested
 * allowed path), and it is the ONLY violation reported — every other
 * legitimate edge in both real fixtures (including the cross-layer ones in
 * the mixed NgModule/standalone fixture, R4) is correctly left alone.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as angularCompiler from '@angular/compiler';
import * as typescript from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';

import { indexProject } from '../../src/indexer/index.js';
import { evaluateRules, resolveLayerForPath } from '../../src/rules/evaluate.js';
import { RulesFileSchema } from '../../src/rules/schema.js';

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url));

/**
 * Indexes a fixture in place, with the on-disk cache redirected to a scratch
 * directory: `indexProject` otherwise writes under `<root>/.angular-mcp/cache`
 * (graph/cache.ts), and this test must never write into `fixtures/`.
 *
 * It indexes the fixture as it really is — `tsconfig.app.json` with
 * `files: ["src/main.ts"]` and specs behind `tsconfig.spec.json`, the layout
 * the Angular CLI generates. Exercising the real layout is the point: the
 * indexer walks the program's transitive closure across every tsconfig the
 * project declares (see indexer/index.ts and test/indexer/real-layout.test.ts),
 * so no widened copy of the config is needed to see the whole graph.
 */
async function indexFixture(name: string) {
  const cacheDir = await mkdtemp(join(tmpdir(), `rules-fixture-${name}-`));
  scratchDirs.push(cacheDir);
  const root = join(REPO_ROOT, 'fixtures', name);
  return indexProject({ root, typescript, angularCompiler, cacheDir, force: true });
}

const scratchDirs: string[] = [];
afterEach(async () => {
  await Promise.all(scratchDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const NO_HTTP_IN_COMPONENTS = {
  id: 'no-http-in-components',
  description: 'Components do not make direct HTTP calls.',
  forbid: { edge: 'calls_http' as const, from: 'Component' as const },
};

describe('rules engine against the real standalone-app fixture', () => {
  const rules = RulesFileSchema.parse({
    version: 1,
    layers: {
      ui: { match: ['src/app/**/*.component.ts'] },
      core: { match: ['src/app/core/**'] },
      routing: { match: ['src/app/**/*.routes.ts'] },
    },
    boundaries: {
      ui: { may_depend_on: ['core'] },
      routing: { may_depend_on: ['ui', 'core'] },
      core: { may_depend_on: [] },
    },
    constraints: [
      NO_HTTP_IN_COMPONENTS,
      {
        id: 'services-own-http',
        description: 'Only core services call HTTP directly.',
        forbid: { edge: 'calls_http', from_layer_not: 'core' },
      },
    ],
  });

  it('detects exactly the planted violation, with a suggested allowed path, and nothing else', async () => {
    const { graph, stats } = await indexFixture('standalone-app');

    expect(stats.brokenFiles).toEqual([]);
    expect(graph.nodeCount).toBeGreaterThan(0);

    // Sanity check the layer resolution itself before trusting the violation count.
    expect(resolveLayerForPath(rules, 'src/app/features/orders/order-list/order-list.component.ts')).toBe('ui');
    expect(resolveLayerForPath(rules, 'src/app/core/services/order.service.ts')).toBe('core');
    expect(resolveLayerForPath(rules, 'src/app/app.routes.ts')).toBe('routing');

    const violations = evaluateRules(graph, rules);
    const ruleIds = violations.map((v) => v.ruleId).sort();
    // Both forbid constraints fire on the SAME planted edge (no-http-in-components
    // matches by node kind, services-own-http by layer) — two violations, one root cause.
    expect(ruleIds).toEqual(['no-http-in-components', 'services-own-http']);

    for (const violation of violations) {
      expect(violation.file).toBe('src/app/features/orders/order-detail/order-detail.component.ts');
      expect(violation.suggestedPath).toBeDefined();
    }
  });

  it('reports zero boundary violations (every layer dependency in the fixture is declared)', async () => {
    const { graph } = await indexFixture('standalone-app');

    const boundariesOnly = RulesFileSchema.parse({ ...rules, constraints: [] });
    expect(evaluateRules(graph, boundariesOnly)).toEqual([]);
  });
});

describe('rules engine against the real ngmodule-app fixture (mixed NgModule + standalone, R4)', () => {
  const rules = RulesFileSchema.parse({
    version: 1,
    layers: {
      shell: { match: ['src/app/app.module.ts', 'src/app/app-routing.module.ts', 'src/app/app.component.ts'] },
      feature: { match: ['src/app/features/**'] },
      shared: { match: ['src/app/shared/**'] },
      core: { match: ['src/app/core/**'] },
    },
    boundaries: {
      shell: { may_depend_on: ['feature', 'core', 'shared'] },
      feature: { may_depend_on: ['core', 'shared'] },
      shared: { may_depend_on: [] },
      core: { may_depend_on: [] },
    },
    constraints: [NO_HTTP_IN_COMPONENTS],
  });

  it('reports zero violations on the real, unmodified fixture', async () => {
    const { graph, stats } = await indexFixture('ngmodule-app');

    expect(stats.brokenFiles).toEqual([]);
    expect(graph.nodeCount).toBeGreaterThan(0);

    // Sanity check: GreetingModule (feature) legitimately imports SharedModule
    // (shared) and provides GreetingService (core) — cross-layer edges that
    // must be permitted, not absent, for this test to mean anything.
    expect(resolveLayerForPath(rules, 'src/app/features/greeting/greeting.module.ts')).toBe('feature');
    expect(resolveLayerForPath(rules, 'src/app/shared/shared.module.ts')).toBe('shared');
    expect(resolveLayerForPath(rules, 'src/app/core/greeting.service.ts')).toBe('core');

    const violations = evaluateRules(graph, rules);
    expect(violations).toEqual([]);
  });
});
