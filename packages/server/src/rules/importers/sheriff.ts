/**
 * Imports layers and boundaries from an existing `@softarc/sheriff` config
 * (`sheriff.config.ts`). See docs/PLAN.md, section 5.3 and risk R10: when a
 * project already declares its module tags and dependency rules with
 * sheriff, the rules engine reuses them instead of asking for a duplicate
 * `layers`/`boundaries` section in `angular-mcp.rules.yaml`.
 *
 * The config file is parsed as an AST (never executed — see ast-literal.ts).
 * Only the statically-literal subset of sheriff's config is supported:
 * - `tagging`: a nested object mapping folder path segments to one or more
 *   string tags. Each `(path, tag)` pair becomes a layer named after the tag,
 *   matching every file under that path (`<path>/**`). A folder tagged with
 *   several tags contributes to several layers.
 * - `depRules`: a map from a literal tag name to the list of tags it may
 *   depend on. The `sameTag` marker is dropped (a layer may always depend on
 *   itself; see evaluate.ts, which never flags a same-layer edge). Wildcard
 *   keys/values (e.g. `'domain:*'`, `'*'`) are not modeled by this engine's
 *   discrete `may_depend_on` list and are reported as a warning instead of
 *   silently guessed (P4).
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type * as TS from 'typescript';

import type { BoundaryDef, LayerDef } from '../schema.js';
import type { Literal } from './ast-literal.js';
import { findObjectLiteralContainingAnyKey, getLiteralProperty, isLiteralArray, isLiteralIdentifier, isLiteralObject, isLiteralString, nodeToLiteral } from './ast-literal.js';
import type { ImporterResult } from './types.js';

const SHERIFF_CONFIG_FILENAMES = ['sheriff.config.ts', 'sheriff.config.mts', 'sheriff.config.js'];

function collectTaggingLayers(tagging: Literal | undefined, warnings: string[]): Record<string, LayerDef> {
  const layers: Record<string, LayerDef> = {};

  function addTag(path: string, tag: string): void {
    const glob = `${path}/**`;
    const existing = layers[tag]?.match ?? [];
    if (!existing.includes(glob)) {
      layers[tag] = { match: [...existing, glob] };
    }
  }

  function walk(node: Literal | undefined, path: string): void {
    if (isLiteralString(node)) {
      addTag(path, node);
      return;
    }
    if (isLiteralArray(node)) {
      for (const item of node) {
        if (isLiteralString(item)) addTag(path, item);
        else warnings.push(`sheriff.config.ts: a tag under "${path}" could not be statically resolved and was skipped.`);
      }
      return;
    }
    if (isLiteralObject(node)) {
      for (const [segment, value] of Object.entries(node)) {
        walk(value, `${path}/${segment}`);
      }
      return;
    }
    warnings.push(`sheriff.config.ts: "tagging" under "${path}" could not be statically resolved and was skipped.`);
  }

  if (isLiteralObject(tagging)) {
    for (const [topPath, value] of Object.entries(tagging)) {
      walk(value, topPath);
    }
  }

  return layers;
}

function collectDepRuleBoundaries(depRules: Literal | undefined, warnings: string[]): Record<string, BoundaryDef> {
  const boundaries: Record<string, BoundaryDef> = {};
  if (!isLiteralObject(depRules)) return boundaries;

  for (const [sourceTag, value] of Object.entries(depRules)) {
    if (sourceTag.includes('*')) {
      warnings.push(`sheriff.config.ts: depRules wildcard key "${sourceTag}" is not supported and was skipped.`);
      continue;
    }

    const entries = isLiteralArray(value) ? value : [value];
    const mayDependOn: string[] = [];

    for (const entry of entries) {
      if (isLiteralString(entry)) {
        if (entry.includes('*')) {
          warnings.push(`sheriff.config.ts: depRules["${sourceTag}"] wildcard target "${entry}" is not supported and was skipped.`);
        } else {
          mayDependOn.push(entry);
        }
        continue;
      }
      if (isLiteralIdentifier(entry)) {
        if (entry.__ident !== 'sameTag') {
          warnings.push(
            `sheriff.config.ts: depRules["${sourceTag}"] references identifier "${entry.__ident}", which is not supported and was skipped.`,
          );
        }
        continue;
      }
      warnings.push(`sheriff.config.ts: depRules["${sourceTag}"] has an entry that could not be statically resolved and was skipped.`);
    }

    boundaries[sourceTag] = { may_depend_on: mayDependOn };
  }

  return boundaries;
}

/**
 * Reads `sheriff.config.ts` (or `.mts`/`.js`) at `root`, if present, and
 * translates its `tagging`/`depRules` into layers/boundaries. Returns
 * `undefined` when no sheriff config file exists — that is the common case
 * and not an error.
 */
export async function importSheriffConfig(root: string, typescript: typeof TS): Promise<ImporterResult | undefined> {
  for (const fileName of SHERIFF_CONFIG_FILENAMES) {
    const filePath = join(root, fileName);
    let text: string;
    try {
      text = await readFile(filePath, 'utf8');
    } catch {
      continue;
    }

    const sourceFile = typescript.createSourceFile(fileName, text, typescript.ScriptTarget.Latest, true);
    const configLiteralNode = findObjectLiteralContainingAnyKey(typescript, sourceFile, ['tagging', 'depRules']);

    if (!configLiteralNode) {
      return {
        layers: {},
        boundaries: {},
        warnings: [
          `Found "${fileName}" but could not statically locate a "tagging"/"depRules" object literal in it; nothing was imported.`,
        ],
      };
    }

    const literal = nodeToLiteral(typescript, configLiteralNode);
    const warnings: string[] = [];
    const layers = collectTaggingLayers(getLiteralProperty(literal, 'tagging'), warnings);
    const boundaries = collectDepRuleBoundaries(getLiteralProperty(literal, 'depRules'), warnings);

    return { layers, boundaries, warnings };
  }

  return undefined;
}
