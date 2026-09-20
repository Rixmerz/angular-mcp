import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as typescript from 'typescript';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  loadEffectiveRules,
  loadRulesFile,
  parseRulesYaml,
  RulesValidationError,
  validateLayerReferences,
} from '../../src/rules/load.js';
import { RULES_FILE_NAME, RulesFileSchema } from '../../src/rules/schema.js';

describe('parseRulesYaml', () => {
  it('parses a valid rules file', () => {
    const yaml = [
      'version: 1',
      'layers:',
      '  ui:',
      '    match: ["src/app/**/*.component.ts"]',
      '',
    ].join('\n');

    const rules = parseRulesYaml(yaml, 'test.rules.yaml');
    expect(rules.layers.ui?.match).toEqual(['src/app/**/*.component.ts']);
  });

  it('reports a YAML syntax error with its line number', () => {
    const yaml = 'version: 1\nlayers:\n  ui: [unterminated\n';

    expect(() => parseRulesYaml(yaml, 'test.rules.yaml')).toThrow(RulesValidationError);
    try {
      parseRulesYaml(yaml, 'test.rules.yaml');
      expect.fail('expected parseRulesYaml to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(RulesValidationError);
      const validationError = error as RulesValidationError;
      expect(validationError.issues.some((issue) => /line \d+/.test(issue))).toBe(true);
    }
  });

  it('reports a schema violation naming the offending YAML line', () => {
    const yaml = ['version: 2', 'layers:', '  ui:', '    match: ["a"]', ''].join('\n');

    try {
      parseRulesYaml(yaml, 'test.rules.yaml');
      expect.fail('expected parseRulesYaml to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(RulesValidationError);
      const validationError = error as RulesValidationError;
      expect(validationError.issues.some((issue) => issue.includes('line 1'))).toBe(true);
      expect(validationError.issues.some((issue) => issue.includes('version'))).toBe(true);
    }
  });

  it('locates a nested schema violation at its own line, not line 1', () => {
    const yaml = ['version: 1', 'layers:', '  ui:', '    match: []', ''].join('\n');

    try {
      parseRulesYaml(yaml, 'test.rules.yaml');
      expect.fail('expected parseRulesYaml to throw');
    } catch (error) {
      const validationError = error as RulesValidationError;
      expect(validationError.issues.some((issue) => issue.includes('line 4'))).toBe(true);
    }
  });
});

describe('loadRulesFile', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rules-load-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('reads and validates a rules file from disk', async () => {
    const filePath = join(root, RULES_FILE_NAME);
    await writeFile(filePath, 'version: 1\n', 'utf8');

    const rules = await loadRulesFile(filePath);
    expect(rules.version).toBe(1);
  });

  it('reports a missing file with an actionable message naming the expected file', async () => {
    const filePath = join(root, RULES_FILE_NAME);

    try {
      await loadRulesFile(filePath);
      expect.fail('expected loadRulesFile to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(RulesValidationError);
      const validationError = error as RulesValidationError;
      expect(validationError.issues.some((issue) => issue.includes(RULES_FILE_NAME))).toBe(true);
    }
  });
});

describe('validateLayerReferences', () => {
  it('returns no issues when every reference resolves', () => {
    const rules = RulesFileSchema.parse({
      version: 1,
      layers: { ui: { match: ['**/*.ts'] }, shared: { match: ['shared/**'] } },
      boundaries: { ui: { may_depend_on: ['shared'] } },
      constraints: [{ id: 'c1', description: 'd', forbid: { edge: 'calls_http', from_layer_not: 'shared' } }],
    });

    expect(validateLayerReferences(rules)).toEqual([]);
  });

  it('flags a boundary key that is not a declared layer', () => {
    const rules = RulesFileSchema.parse({
      version: 1,
      layers: { ui: { match: ['**/*.ts'] } },
      boundaries: { data: { may_depend_on: [] } },
    });

    const issues = validateLayerReferences(rules);
    expect(issues.some((issue) => issue.includes('boundaries.data'))).toBe(true);
  });

  it('flags a may_depend_on target that is not a declared layer', () => {
    const rules = RulesFileSchema.parse({
      version: 1,
      layers: { ui: { match: ['**/*.ts'] } },
      boundaries: { ui: { may_depend_on: ['nonexistent'] } },
    });

    const issues = validateLayerReferences(rules);
    expect(issues.some((issue) => issue.includes('nonexistent'))).toBe(true);
  });

  it('flags a forbid.from_layer_not that is not a declared layer', () => {
    const rules = RulesFileSchema.parse({
      version: 1,
      constraints: [{ id: 'c1', description: 'd', forbid: { edge: 'calls_http', from_layer_not: 'ghost' } }],
    });

    const issues = validateLayerReferences(rules);
    expect(issues.some((issue) => issue.includes('ghost'))).toBe(true);
  });
});

describe('loadEffectiveRules', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rules-effective-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('uses defaults when no rules file exists and no importer applies', async () => {
    const effective = await loadEffectiveRules(root, { typescript });
    expect(effective.rules.layers).toEqual({});
    expect(effective.layerOrigin).toEqual({});
  });

  it('marks every layer declared in the own file as origin "own"', async () => {
    await writeFile(
      join(root, RULES_FILE_NAME),
      ['version: 1', 'layers:', '  ui:', '    match: ["**/*.ts"]', ''].join('\n'),
      'utf8',
    );

    const effective = await loadEffectiveRules(root, { typescript });
    expect(effective.layerOrigin.ui).toBe('own');
  });

  it('merges a layer imported from sheriff with the project\'s own boundaries referencing it (R10)', async () => {
    await writeFile(
      join(root, 'sheriff.config.ts'),
      [
        "export const config = {",
        "  tagging: { 'src/app/shared': ['shared'] },",
        '  depRules: { shared: [] },',
        '};',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      join(root, RULES_FILE_NAME),
      [
        'version: 1',
        'layers:',
        '  ui:',
        '    match: ["src/app/**/*.component.ts"]',
        'boundaries:',
        '  ui:',
        '    may_depend_on: ["shared"]',
        '',
      ].join('\n'),
      'utf8',
    );

    const effective = await loadEffectiveRules(root, { typescript });
    expect(effective.layerOrigin).toEqual({ shared: 'sheriff', ui: 'own' });
    expect(effective.rules.boundaries.ui?.may_depend_on).toEqual(['shared']);
  });

  it('rejects a layer declared both in the own file and by an importer (R10)', async () => {
    await mkdir(join(root, 'src/app/shared'), { recursive: true });
    await writeFile(
      join(root, 'sheriff.config.ts'),
      ["export const config = {", "  tagging: { 'src/app/shared': ['shared'] },", '  depRules: {},', '};', ''].join('\n'),
      'utf8',
    );
    await writeFile(
      join(root, RULES_FILE_NAME),
      ['version: 1', 'layers:', '  shared:', '    match: ["src/app/shared/**"]', ''].join('\n'),
      'utf8',
    );

    await expect(loadEffectiveRules(root, { typescript })).rejects.toThrow(RulesValidationError);
  });

  it('rejects an undeclared layer reference that survives the merge', async () => {
    await writeFile(
      join(root, RULES_FILE_NAME),
      [
        'version: 1',
        'layers:',
        '  ui:',
        '    match: ["**/*.ts"]',
        'boundaries:',
        '  ui:',
        '    may_depend_on: ["ghost"]',
        '',
      ].join('\n'),
      'utf8',
    );

    await expect(loadEffectiveRules(root, { typescript })).rejects.toThrow(RulesValidationError);
  });
});
