/**
 * Imports layers and boundaries from an existing Nx module-boundary setup.
 * See docs/PLAN.md, section 5.3 and risk R10.
 *
 * Two independent pieces of Nx configuration are read (never executed — see
 * ast-literal.ts):
 * - Per-project `tags` (from every `project.json` under `root`): each tag
 *   becomes a layer matching every tagged project's source root
 *   (`<sourceRoot>/**`). A project with several tags contributes to several
 *   layers.
 * - The `@nx/enforce-module-boundaries` ESLint rule's `depConstraints`
 *   (`{ sourceTag, onlyDependOnLibsWithTags }[]`), read from `.eslintrc.json`
 *   or a flat `eslint.config.{js,mjs,cjs}`: each constraint becomes a
 *   boundary. A wildcard `sourceTag` is not modeled by this engine's
 *   discrete boundaries map and is reported as a warning; a wildcard
 *   `onlyDependOnLibsWithTags: ['*']` expands to every tag discovered from
 *   `project.json` (Nx's own meaning: "may depend on anything").
 */

import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

import type * as TS from 'typescript';

import { normalizeRelativePath } from '../../graph/model.js';
import type { BoundaryDef, LayerDef } from '../schema.js';
import { findObjectLiteralContainingAnyKey, getLiteralProperty, isLiteralArray, isLiteralObject, isLiteralString, nodeToLiteral } from './ast-literal.js';
import type { Literal } from './ast-literal.js';
import type { ImporterResult } from './types.js';

const IGNORED_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'coverage', '.angular-mcp']);
const MAX_SEARCH_DEPTH = 6;

interface NxProject {
  readonly root: string;
  readonly sourceRoot?: string;
  readonly tags: readonly string[];
}

async function findProjectJsonFiles(root: string): Promise<string[]> {
  const results: string[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > MAX_SEARCH_DEPTH) return;

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name)) continue;
        await walk(join(dir, entry.name), depth + 1);
      } else if (entry.isFile() && entry.name === 'project.json') {
        results.push(join(dir, entry.name));
      }
    }
  }

  await walk(root, 0);
  return results;
}

async function readNxProjects(root: string): Promise<NxProject[]> {
  const projectJsonPaths = await findProjectJsonFiles(root);
  const projects: NxProject[] = [];

  for (const projectJsonPath of projectJsonPaths) {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(projectJsonPath, 'utf8'));
    } catch {
      continue;
    }
    if (raw === null || typeof raw !== 'object') continue;

    const data = raw as { root?: unknown; sourceRoot?: unknown; tags?: unknown };
    const projectDir = normalizeRelativePath(relative(root, join(projectJsonPath, '..')));
    const projectRoot = typeof data.root === 'string' ? normalizeRelativePath(data.root) : projectDir;
    const sourceRoot = typeof data.sourceRoot === 'string' ? normalizeRelativePath(data.sourceRoot) : undefined;
    const tags = Array.isArray(data.tags) ? data.tags.filter((tag): tag is string => typeof tag === 'string') : [];

    projects.push({ root: projectRoot, sourceRoot, tags });
  }

  return projects;
}

function collectTagLayers(projects: readonly NxProject[]): { layers: Record<string, LayerDef>; allTags: Set<string> } {
  const layers: Record<string, LayerDef> = {};
  const allTags = new Set<string>();

  for (const project of projects) {
    const basePath = project.sourceRoot ?? project.root;
    for (const tag of project.tags) {
      allTags.add(tag);
      const glob = `${basePath}/**`;
      const existing = layers[tag]?.match ?? [];
      if (!existing.includes(glob)) {
        layers[tag] = { match: [...existing, glob] };
      }
    }
  }

  return { layers, allTags };
}

async function readEslintDepConstraintsLiteral(root: string, typescript: typeof TS): Promise<Literal | undefined> {
  const jsonCandidates = ['.eslintrc.json'];
  for (const fileName of jsonCandidates) {
    try {
      const raw = JSON.parse(await readFile(join(root, fileName), 'utf8')) as {
        rules?: Record<string, unknown>;
      };
      const rule = raw.rules?.['@nx/enforce-module-boundaries'];
      if (Array.isArray(rule) && rule.length > 1) return rule[1] as Literal;
    } catch {
      // Try the next candidate.
    }
  }

  const astCandidates = ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', '.eslintrc.js'];
  for (const fileName of astCandidates) {
    let text: string;
    try {
      text = await readFile(join(root, fileName), 'utf8');
    } catch {
      continue;
    }

    const sourceFile = typescript.createSourceFile(fileName, text, typescript.ScriptTarget.Latest, true);
    const ruleArrayHolder = findObjectLiteralContainingAnyKey(typescript, sourceFile, ['@nx/enforce-module-boundaries']);
    if (!ruleArrayHolder) continue;

    const literal = nodeToLiteral(typescript, ruleArrayHolder);
    const ruleValue = getLiteralProperty(literal, '@nx/enforce-module-boundaries');
    if (isLiteralArray(ruleValue) && ruleValue.length > 1) return ruleValue[1];
  }

  return undefined;
}

function collectDepConstraintBoundaries(
  depConstraintsOptions: Literal | undefined,
  allTags: ReadonlySet<string>,
  warnings: string[],
): Record<string, BoundaryDef> {
  const boundaries: Record<string, BoundaryDef> = {};

  const depConstraints = getLiteralProperty(depConstraintsOptions, 'depConstraints');
  if (!isLiteralArray(depConstraints)) return boundaries;

  for (const entry of depConstraints) {
    if (!isLiteralObject(entry)) {
      warnings.push('@nx/enforce-module-boundaries: a depConstraints entry could not be statically resolved and was skipped.');
      continue;
    }

    const sourceTag = getLiteralProperty(entry, 'sourceTag');
    const targets = getLiteralProperty(entry, 'onlyDependOnLibsWithTags');
    if (!isLiteralString(sourceTag) || !isLiteralArray(targets)) {
      warnings.push('@nx/enforce-module-boundaries: a depConstraints entry is missing "sourceTag" or "onlyDependOnLibsWithTags" and was skipped.');
      continue;
    }
    if (sourceTag.includes('*')) {
      warnings.push(`@nx/enforce-module-boundaries: wildcard sourceTag "${sourceTag}" is not supported and was skipped.`);
      continue;
    }

    const mayDependOn = new Set<string>();
    for (const target of targets) {
      if (!isLiteralString(target)) continue;
      if (target === '*') {
        for (const tag of allTags) mayDependOn.add(tag);
        continue;
      }
      mayDependOn.add(target);
    }

    boundaries[sourceTag] = { may_depend_on: [...mayDependOn] };
  }

  return boundaries;
}

/**
 * Reads Nx project tags and the `@nx/enforce-module-boundaries` dependency
 * constraints at `root`, if present, and translates them into layers/
 * boundaries. Returns `undefined` when neither `project.json` files nor a
 * boundary rule configuration were found — the common case, not an error.
 */
export async function importNxBoundaries(root: string, typescript: typeof TS): Promise<ImporterResult | undefined> {
  const projects = await readNxProjects(root);
  const depConstraintsOptions = await readEslintDepConstraintsLiteral(root, typescript);

  if (projects.length === 0 && depConstraintsOptions === undefined) {
    return undefined;
  }

  const { layers, allTags } = collectTagLayers(projects);
  const warnings: string[] = [];
  const boundaries = collectDepConstraintBoundaries(depConstraintsOptions, allTags, warnings);

  return { layers, boundaries, warnings };
}
