/**
 * `angular_list_rules`: the loaded rules, where each layer came from (the
 * project's own file, sheriff or Nx), and which layer every project file
 * resolves to. See docs/PLAN.md, section 6, Phase 2.
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type * as TS from 'typescript';

import { normalizeRelativePath } from '../../graph/model.js';
import type { Fact, FormattedResponse, FormatParams } from '../../format/index.js';
import { formatFacts } from '../../format/index.js';
import { resolveLayerForPath } from '../evaluate.js';
import type { EffectiveRules, RuleOrigin } from '../load.js';
import { loadEffectiveRules } from '../load.js';

const IGNORED_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'coverage', '.angular-mcp']);

async function listProjectFiles(root: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name)) continue;
        await walk(join(dir, entry.name));
      } else if (entry.isFile()) {
        files.push(normalizeRelativePath(join(dir, entry.name).slice(root.length + 1)));
      }
    }
  }

  await walk(root);
  return files.sort();
}

export interface ListRulesInput extends FormatParams {
  readonly root: string;
}

export interface ListRulesToolDeps {
  readonly typescript: typeof TS;
  /** Reuses already-loaded effective rules instead of reading them from disk again. */
  readonly effectiveRules?: EffectiveRules;
}

export interface ListRulesResult {
  readonly rules: EffectiveRules['rules'];
  readonly layerOrigin: Readonly<Record<string, RuleOrigin>>;
  readonly warnings: readonly string[];
  readonly response: FormattedResponse;
}

function fileLayerFact(root: string, path: string, effective: EffectiveRules): Fact {
  const layer = resolveLayerForPath(effective.rules, path);
  const origin = layer ? effective.layerOrigin[layer] : undefined;

  return {
    kind: 'file-layer',
    summary: layer
      ? `"${path}" → layer "${layer}"${origin ? ` (${origin})` : ''}`
      : `"${path}" → no layer matches`,
    provenance: { file: path },
    confidence: layer ? 'certain' : 'unknown',
    detail: { root, path, layer: layer ?? null, origin: origin ?? null },
  };
}

/**
 * Lists the effective rules for the project at `input.root`: every declared
 * layer with its origin, the boundaries, the constraints, the decisions, and
 * (paginated per `limit`/`offset`/`format`) which layer each project file
 * resolves to.
 */
export async function listRules(input: ListRulesInput, deps: ListRulesToolDeps): Promise<ListRulesResult> {
  const effective = deps.effectiveRules ?? (await loadEffectiveRules(input.root, { typescript: deps.typescript }));
  const files = await listProjectFiles(input.root);
  const facts = files.map((path) => fileLayerFact(input.root, path, effective));

  return {
    rules: effective.rules,
    layerOrigin: effective.layerOrigin,
    warnings: effective.warnings,
    response: formatFacts(facts, { ...input, title: 'Layers resolved per file' }),
  };
}
