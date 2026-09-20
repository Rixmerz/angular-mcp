import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as typescript from 'typescript';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { importSheriffConfig } from '../../../src/rules/importers/sheriff.js';

describe('importSheriffConfig', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sheriff-import-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('returns undefined when there is no sheriff.config.ts', async () => {
    expect(await importSheriffConfig(root, typescript)).toBeUndefined();
  });

  it('translates tagging into layers and depRules into boundaries', async () => {
    await writeFile(
      join(root, 'sheriff.config.ts'),
      [
        "import { sameTag } from '@softarc/sheriff-core';",
        '',
        'export const config = {',
        '  tagging: {',
        "    'src/app': {",
        "      orders: ['domain:orders'],",
        "      users: ['domain:users'],",
        '    },',
        "    'src/app/shared': ['shared'],",
        '  },',
        '  depRules: {',
        "    'domain:orders': ['shared', sameTag],",
        "    'domain:users': ['shared'],",
        "    shared: [],",
        '  },',
        '};',
        '',
      ].join('\n'),
      'utf8',
    );

    const result = await importSheriffConfig(root, typescript);
    expect(result).toBeDefined();
    expect(result?.layers).toEqual({
      'domain:orders': { match: ['src/app/orders/**'] },
      'domain:users': { match: ['src/app/users/**'] },
      shared: { match: ['src/app/shared/**'] },
    });
    expect(result?.boundaries).toEqual({
      'domain:orders': { may_depend_on: ['shared'] },
      'domain:users': { may_depend_on: ['shared'] },
      shared: { may_depend_on: [] },
    });
    expect(result?.warnings).toEqual([]);
  });

  it('warns instead of guessing at a wildcard depRules key', async () => {
    await writeFile(
      join(root, 'sheriff.config.ts'),
      [
        'export const config = {',
        "  tagging: { 'src/app/shared': ['shared'] },",
        "  depRules: { 'domain:*': ['shared'] },",
        '};',
        '',
      ].join('\n'),
      'utf8',
    );

    const result = await importSheriffConfig(root, typescript);
    expect(result?.boundaries).toEqual({});
    expect(result?.warnings.some((w) => w.includes('domain:*'))).toBe(true);
  });

  it('never executes the config file: a thrown top-level statement does not propagate', async () => {
    await writeFile(
      join(root, 'sheriff.config.ts'),
      [
        "throw new Error('this must never run');",
        'export const config = {',
        "  tagging: { 'src/app/shared': ['shared'] },",
        '  depRules: { shared: [] },',
        '};',
        '',
      ].join('\n'),
      'utf8',
    );

    const result = await importSheriffConfig(root, typescript);
    expect(result?.layers.shared).toEqual({ match: ['src/app/shared/**'] });
  });
});
