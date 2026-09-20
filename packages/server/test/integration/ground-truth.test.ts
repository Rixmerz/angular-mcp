/**
 * Phase 1 exit criterion (docs/PLAN.md, sections 7, 9.2 and 10): the indexed
 * graph of each fixture, compared against a ground truth written by hand from
 * the fixture's source.
 *
 * The comparison is exact on the things a human enumerated — the declared
 * symbols, which components are standalone, which files hold templates and
 * specs, how many HTTP calls and routes each file contains — and any
 * divergence fails. Precision and recall are computed and asserted against
 * the plan's thresholds (>= 95% and >= 90%) as well, so the numbers the plan
 * promises are measured rather than assumed.
 *
 * The fixtures are indexed in place with the cache redirected to a temp
 * directory: nothing is written into `fixtures/`.
 */

import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as angularCompiler from '@angular/compiler';
import * as typescript from 'typescript';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ProjectGraph } from '../../src/graph/index.js';
import type { ComponentNode, GraphNode, NgModuleNode } from '../../src/graph/model.js';
import { indexProject } from '../../src/indexer/index.js';

const REPO_ROOT = join(process.cwd(), '..', '..');

interface ExpectedSymbol {
  readonly kind: string;
  readonly path: string;
  readonly name: string;
  readonly selector?: string;
}

interface ExpectedRelation {
  readonly kind: string;
  readonly from?: string;
  readonly to?: string;
  readonly count: number;
}

interface ExpectedGraph {
  readonly symbols: readonly ExpectedSymbol[];
  readonly signalsByOwner?: Record<string, string[] | string>;
  readonly httpCallsByFile: Record<string, number | string>;
  readonly routeCount: Record<string, number | string>;
  readonly templateFiles: readonly string[];
  readonly specFiles: readonly string[];
  readonly relations: readonly ExpectedRelation[];
  readonly standaloneComponents?: { standalone: string[]; declaredInNgModule: string[] };
  readonly inlineTemplateOwners?: { owners: string[] };
  readonly ngModuleDeclarations?: Record<string, string[] | string>;
}

/** `_comment` keys document the file; they are not data. */
function withoutComments<T extends Record<string, unknown>>(record: T): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === '_comment') continue;
    result[key] = value as number;
  }
  return result;
}

async function readExpected(fixture: string): Promise<ExpectedGraph> {
  const text = await readFile(join(REPO_ROOT, 'fixtures', fixture, 'expected-graph.json'), 'utf8');
  return JSON.parse(text) as ExpectedGraph;
}

/** A symbol as the ground truth addresses it: kind, file, name — never an internal node id. */
function symbolKey(symbol: { kind: string; path: string; name: string }): string {
  return `${symbol.kind}|${symbol.path}|${symbol.name}`;
}

/** The node kinds a human writes by hand; the rest are derived and pinned by count instead. */
const DECLARED_KINDS = new Set(['Component', 'Directive', 'Pipe', 'Service', 'NgModule', 'Guard', 'Resolver', 'Interceptor']);

function declaredSymbolsOf(graph: ProjectGraph): string[] {
  return graph
    .allNodes()
    .filter((node) => DECLARED_KINDS.has(node.kind))
    .map(symbolKey)
    .sort();
}

function countByFile(nodes: readonly GraphNode[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const node of nodes) counts[node.path] = (counts[node.path] ?? 0) + 1;
  return counts;
}

interface Score {
  readonly precision: number;
  readonly recall: number;
  readonly falsePositives: string[];
  readonly falseNegatives: string[];
}

/** Precision = of what was found, how much is real. Recall = of what is real, how much was found. */
function score(found: readonly string[], expected: readonly string[]): Score {
  const expectedSet = new Set(expected);
  const foundSet = new Set(found);

  const truePositives = found.filter((item) => expectedSet.has(item));
  const falsePositives = found.filter((item) => !expectedSet.has(item));
  const falseNegatives = expected.filter((item) => !foundSet.has(item));

  return {
    precision: found.length === 0 ? 1 : truePositives.length / found.length,
    recall: expected.length === 0 ? 1 : truePositives.length / expected.length,
    falsePositives,
    falseNegatives,
  };
}

/** Every relation the ground truth names, flattened to comparable strings. */
function relationKeys(graph: ProjectGraph, expected: readonly ExpectedRelation[]): string[] {
  const nameOf = new Map(graph.allNodes().map((node) => [node.id, node.name]));
  const keys: string[] = [];

  for (const relation of expected) {
    const matching = graph.allEdges().filter((edge) => {
      if (edge.kind !== relation.kind) return false;
      if (relation.from !== undefined && nameOf.get(edge.from) !== relation.from) return false;
      if (relation.to !== undefined && nameOf.get(edge.to) !== relation.to) return false;
      return true;
    });

    keys.push(`${relation.kind}|${relation.from ?? '*'}->${relation.to ?? '*'}|${matching.length}`);
  }

  return keys;
}

function expectedRelationKeys(expected: readonly ExpectedRelation[]): string[] {
  return expected.map((relation) => `${relation.kind}|${relation.from ?? '*'}->${relation.to ?? '*'}|${relation.count}`);
}

describe.each(['standalone-app', 'ngmodule-app'])('ground truth: %s', (fixture) => {
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), `ground-truth-${fixture}-`));
  });

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  async function indexFixture(): Promise<ProjectGraph> {
    const { graph } = await indexProject({
      root: join(REPO_ROOT, 'fixtures', fixture),
      typescript,
      angularCompiler,
      force: true,
      cacheDir,
    });
    return graph;
  }

  it('finds exactly the declared symbols, and meets the plan\'s precision and recall thresholds', async () => {
    const graph = await indexFixture();
    const expected = await readExpected(fixture);

    const found = declaredSymbolsOf(graph);
    const wanted = expected.symbols.map(symbolKey).sort();

    const { precision, recall, falsePositives, falseNegatives } = score(found, wanted);

    // Reported before the assertions, so a failure says what diverged rather
    // than just that a number was too low.
    expect({ falsePositives, falseNegatives }).toEqual({ falsePositives: [], falseNegatives: [] });
    expect(precision).toBeGreaterThanOrEqual(0.95);
    expect(recall).toBeGreaterThanOrEqual(0.9);
  });

  it('records each component\'s selector as written in its decorator', async () => {
    const graph = await indexFixture();
    const expected = await readExpected(fixture);

    const foundSelectors = new Map(
      graph.nodesByKind('Component').map((node) => [node.name, (node as ComponentNode).selector]),
    );

    for (const symbol of expected.symbols) {
      if (symbol.selector === undefined) continue;
      expect(foundSelectors.get(symbol.name), symbol.name).toBe(symbol.selector);
    }
  });

  it('finds the HTTP calls the fixture makes, per file', async () => {
    const graph = await indexFixture();
    const expected = await readExpected(fixture);

    expect(countByFile(graph.nodesByKind('HttpCall'))).toEqual(withoutComments(expected.httpCallsByFile));
  });

  it('finds the routes each routing file declares', async () => {
    const graph = await indexFixture();
    const expected = await readExpected(fixture);

    expect(countByFile(graph.nodesByKind('Route'))).toEqual(withoutComments(expected.routeCount));
  });

  it('finds a template for every component that has one, and no others', async () => {
    const graph = await indexFixture();
    const expected = await readExpected(fixture);

    const externalTemplates = graph
      .nodesByKind('Template')
      .filter((node) => node.path.endsWith('.html'))
      .map((node) => node.path)
      .sort();

    expect(externalTemplates).toEqual([...expected.templateFiles].sort());
  });

  it('finds every spec file', async () => {
    const graph = await indexFixture();
    const expected = await readExpected(fixture);

    const specs = graph.nodesByKind('Spec').map((node) => node.path).sort();

    expect(specs).toEqual([...expected.specFiles].sort());
  });

  it('reproduces the relations the ground truth names, with the same multiplicity', async () => {
    const graph = await indexFixture();
    const expected = await readExpected(fixture);

    expect(relationKeys(graph, expected.relations)).toEqual(expectedRelationKeys(expected.relations));
  });
});

describe('ground truth: standalone-app reactive primitives', () => {
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), 'ground-truth-signals-'));
  });

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it('finds every signal, input, output, model and viewChild each component declares', async () => {
    const { graph } = await indexProject({
      root: join(REPO_ROOT, 'fixtures', 'standalone-app'),
      typescript,
      angularCompiler,
      force: true,
      cacheDir,
    });
    const expected = await readExpected('standalone-app');

    const byOwner: Record<string, string[]> = {};
    for (const node of graph.nodesByKind('Signal')) {
      const owner = graph.getNode((node as { ownerRef: string }).ownerRef)?.name;
      if (!owner) continue;
      (byOwner[owner] ??= []).push(node.name);
    }

    for (const [owner, names] of Object.entries(expected.signalsByOwner ?? {})) {
      if (owner === '_comment' || !Array.isArray(names)) continue;
      expect([...(byOwner[owner] ?? [])].sort(), owner).toEqual([...names].sort());
    }
  });
});

describe('ngmodule-app hybrid case (R4)', () => {
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), 'ground-truth-hybrid-'));
  });

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it('records what each NgModule declares, exactly as its decorator writes it', async () => {
    const { graph } = await indexProject({
      root: join(REPO_ROOT, 'fixtures', 'ngmodule-app'),
      typescript,
      angularCompiler,
      force: true,
      cacheDir,
    });
    const expected = await readExpected('ngmodule-app');

    const declarationsByModule = new Map(
      graph.nodesByKind('NgModule').map((node) => [node.name, [...(node as NgModuleNode).declarations]]),
    );

    for (const [moduleName, declarations] of Object.entries(expected.ngModuleDeclarations ?? {})) {
      if (moduleName === '_comment' || !Array.isArray(declarations)) continue;
      expect(declarationsByModule.get(moduleName), moduleName).toEqual(declarations);
    }
  });

  it('marks the standalone component as standalone and the NgModule-declared ones as not', async () => {
    const { graph } = await indexProject({
      root: join(REPO_ROOT, 'fixtures', 'ngmodule-app'),
      typescript,
      angularCompiler,
      force: true,
      cacheDir,
    });
    const expected = await readExpected('ngmodule-app');

    const standalone = graph
      .nodesByKind('Component')
      .filter((node) => (node as ComponentNode).standalone)
      .map((node) => node.name)
      .sort();

    expect(standalone).toEqual([...(expected.standaloneComponents?.standalone ?? [])].sort());

    for (const name of expected.standaloneComponents?.declaredInNgModule ?? []) {
      expect(standalone, name).not.toContain(name);
    }
  });
});
