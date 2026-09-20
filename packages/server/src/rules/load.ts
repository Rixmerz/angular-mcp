/**
 * Loading and validation of `angular-mcp.rules.yaml`. See docs/PLAN.md,
 * sections 4.1 and 5.3, and risk R10 (no duplicated sources of truth with
 * sheriff/Nx).
 *
 * Two things are exported for two different callers:
 * - `loadRulesFile` / `parseRulesYaml`: the project's own rules file, parsed
 *   and validated in isolation. Every error names the offending YAML line.
 * - `loadEffectiveRules`: the rules actually used to evaluate the graph —
 *   the project's own file merged with whatever `sheriff.config.ts` or an Nx
 *   boundary configuration already declares (importers/sheriff.ts,
 *   importers/nx.ts), so the user never has to declare the same layer twice.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { isCollection, LineCounter, parseDocument } from 'yaml';
import type { Document } from 'yaml';
import type * as TS from 'typescript';

import { importNxBoundaries } from './importers/nx.js';
import { importSheriffConfig } from './importers/sheriff.js';
import type { ImporterResult } from './importers/types.js';
import { RULES_FILE_NAME, RulesFileSchema } from './schema.js';
import type { BoundaryDef, LayerDef, RulesFile } from './schema.js';

/**
 * Raised for any problem with a rules file: a YAML syntax error, a schema
 * violation, or a cross-source conflict (R10). Always actionable: every issue
 * names the file (and, when it can be located, the line) and states what is
 * wrong, never just "invalid rules file".
 */
export class RulesValidationError extends Error {
  readonly filePath: string;
  readonly issues: readonly string[];

  constructor(filePath: string, issues: readonly string[]) {
    super(`Invalid rules file "${filePath}":\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
    this.name = 'RulesValidationError';
    this.filePath = filePath;
    this.issues = issues;
  }
}

type IssuePath = readonly (string | number)[];

/** Walks `path` into the parsed YAML document, returning the deepest node it could resolve. */
function findNodeForPath(doc: Document, path: IssuePath): unknown {
  let current: unknown = doc.contents;
  let lastResolved: unknown = current;

  for (const key of path) {
    if (!isCollection(current)) break;
    const next: unknown = current.get(key, true);
    if (next === undefined) break;
    current = next;
    lastResolved = next;
  }

  return lastResolved;
}

function rangeOf(node: unknown): readonly [number, number, number] | undefined {
  if (node !== null && typeof node === 'object' && 'range' in node) {
    return (node as { range?: [number, number, number] }).range;
  }
  return undefined;
}

function lineOf(lineCounter: LineCounter, node: unknown): number | undefined {
  const range = rangeOf(node);
  return range ? lineCounter.linePos(range[0]).line : undefined;
}

/**
 * Parses and validates the text of a rules file. Pure (no filesystem access),
 * so it is testable with inline YAML strings. `sourcePath` is only used to
 * label error messages.
 */
export function parseRulesYaml(yamlText: string, sourcePath: string): RulesFile {
  const lineCounter = new LineCounter();
  const doc = parseDocument(yamlText, { lineCounter });

  if (doc.errors.length > 0) {
    const issues = doc.errors.map((error) => {
      const line = error.linePos?.[0]?.line;
      const location = line !== undefined ? `line ${line}` : 'an unknown location';
      return `YAML syntax error at ${location}: ${error.message.split('\n')[0]}`;
    });
    throw new RulesValidationError(sourcePath, issues);
  }

  const data: unknown = doc.toJS() ?? {};
  const result = RulesFileSchema.safeParse(data);

  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const node = findNodeForPath(doc, issue.path);
      const line = lineOf(lineCounter, node);
      const where = line !== undefined ? `line ${line}` : 'the file';
      const path = issue.path.length > 0 ? issue.path.join('.') : '<root>';
      return `${where} (${path}): ${issue.message}`;
    });
    throw new RulesValidationError(sourcePath, issues);
  }

  return result.data;
}

/** Reads and validates `angular-mcp.rules.yaml` at `filePath`. */
export async function loadRulesFile(filePath: string): Promise<RulesFile> {
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new RulesValidationError(filePath, [
        `File not found. Create "${RULES_FILE_NAME}" at the project root — see docs/RULES.md for the format.`,
      ]);
    }
    throw error;
  }

  return parseRulesYaml(text, filePath);
}

/**
 * Checks that every layer name referenced by `boundaries` or by a
 * `constraints[].forbid.from_layer_not` is actually declared under `layers`.
 * Applied once, uniformly, to the merged (own + imported) rules — see the
 * module doc comment for why this cannot live in the Zod schema.
 */
export function validateLayerReferences(rules: RulesFile): string[] {
  const declaredLayers = new Set(Object.keys(rules.layers));
  const issues: string[] = [];

  for (const [layerName, boundary] of Object.entries(rules.boundaries)) {
    if (!declaredLayers.has(layerName)) {
      issues.push(
        `"boundaries.${layerName}" refers to a layer that is not declared under "layers". ` +
          `Declared layers: ${[...declaredLayers].join(', ') || '(none)'}.`,
      );
    }
    boundary.may_depend_on.forEach((target, index) => {
      if (!declaredLayers.has(target)) {
        issues.push(
          `"boundaries.${layerName}.may_depend_on[${index}]" refers to undeclared layer "${target}".`,
        );
      }
    });
  }

  rules.constraints.forEach((constraint, index) => {
    const requiredLayer = constraint.forbid?.from_layer_not;
    if (requiredLayer !== undefined && !declaredLayers.has(requiredLayer)) {
      issues.push(
        `"constraints[${index}].forbid.from_layer_not" refers to undeclared layer "${requiredLayer}".`,
      );
    }
  });

  return issues;
}

export type RuleOrigin = 'own' | 'sheriff' | 'nx';

export interface EffectiveRules {
  readonly rules: RulesFile;
  /** Which source declared each layer: the project's own file, sheriff or Nx. */
  readonly layerOrigin: Readonly<Record<string, RuleOrigin>>;
  /** Non-fatal notes from the importers (e.g. a wildcard dep rule they could not translate). */
  readonly warnings: readonly string[];
}

export interface LoadEffectiveRulesOptions {
  readonly typescript: typeof TS;
}

function mergeLayerSource(
  source: ImporterResult | undefined,
  origin: RuleOrigin,
  layers: Record<string, LayerDef>,
  boundaries: Record<string, BoundaryDef>,
  layerOrigin: Record<string, RuleOrigin>,
  warnings: string[],
  ownRulesPath: string,
): void {
  if (!source) return;
  warnings.push(...source.warnings);

  for (const [layerName, def] of Object.entries(source.layers)) {
    const existingOrigin = layerOrigin[layerName];
    if (existingOrigin) {
      throw new RulesValidationError(ownRulesPath, [
        `Layer "${layerName}" is declared by both "${existingOrigin}" and "${origin}". ` +
          'R10: a layer must have a single source of truth — remove the duplicate from one side.',
      ]);
    }
    layers[layerName] = def;
    layerOrigin[layerName] = origin;
  }

  for (const [layerName, def] of Object.entries(source.boundaries)) {
    boundaries[layerName] = def;
  }
}

/**
 * Resolves the rules actually used to evaluate a project: its own
 * `angular-mcp.rules.yaml` (if present) merged with whatever `sheriff` or Nx
 * boundary configuration is already in the repository. Throws
 * `RulesValidationError` if a layer is declared twice (R10) or if a layer
 * reference cannot be resolved after merging.
 */
export async function loadEffectiveRules(
  root: string,
  options: LoadEffectiveRulesOptions,
): Promise<EffectiveRules> {
  const ownRulesPath = join(root, RULES_FILE_NAME);

  let own: RulesFile;
  try {
    own = await loadRulesFile(ownRulesPath);
  } catch (error) {
    if (error instanceof RulesValidationError && error.issues.some((issue) => issue.includes('File not found'))) {
      own = RulesFileSchema.parse({ version: 1 });
    } else {
      throw error;
    }
  }

  const [sheriffResult, nxResult] = await Promise.all([
    importSheriffConfig(root, options.typescript),
    importNxBoundaries(root, options.typescript),
  ]);

  const layers: Record<string, LayerDef> = {};
  const boundaries: Record<string, BoundaryDef> = {};
  const layerOrigin: Record<string, RuleOrigin> = {};
  const warnings: string[] = [];

  mergeLayerSource(sheriffResult, 'sheriff', layers, boundaries, layerOrigin, warnings, ownRulesPath);
  mergeLayerSource(nxResult, 'nx', layers, boundaries, layerOrigin, warnings, ownRulesPath);

  for (const [layerName, def] of Object.entries(own.layers)) {
    const existingOrigin = layerOrigin[layerName];
    if (existingOrigin) {
      throw new RulesValidationError(ownRulesPath, [
        `Layer "${layerName}" is declared both in "${RULES_FILE_NAME}" and imported from "${existingOrigin}". ` +
          'R10: a layer must have a single source of truth — remove the duplicate from one side.',
      ]);
    }
    layers[layerName] = def;
    layerOrigin[layerName] = 'own';
  }
  for (const [layerName, def] of Object.entries(own.boundaries)) {
    boundaries[layerName] = def;
  }

  const merged = RulesFileSchema.parse({
    version: own.version,
    layers,
    boundaries,
    constraints: own.constraints,
    decisions: own.decisions,
  });

  const issues = validateLayerReferences(merged);
  if (issues.length > 0) {
    throw new RulesValidationError(ownRulesPath, issues);
  }

  return { rules: merged, layerOrigin, warnings };
}
