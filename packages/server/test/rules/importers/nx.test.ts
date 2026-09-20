import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as typescript from 'typescript';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { importNxBoundaries } from '../../../src/rules/importers/nx.js';

async function writeJson(path: string, data: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2), 'utf8');
}

describe('importNxBoundaries', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'nx-import-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('returns undefined when there are no project.json files and no boundary rule config', async () => {
    expect(await importNxBoundaries(root, typescript)).toBeUndefined();
  });

  it('builds a layer per project tag from project.json files', async () => {
    await writeJson(join(root, 'apps/orders/project.json'), {
      root: 'apps/orders',
      sourceRoot: 'apps/orders/src',
      tags: ['scope:orders', 'type:feature'],
    });
    await writeJson(join(root, 'libs/shared-ui/project.json'), {
      root: 'libs/shared-ui',
      tags: ['scope:shared', 'type:ui'],
    });

    const result = await importNxBoundaries(root, typescript);
    expect(result?.layers).toEqual({
      'scope:orders': { match: ['apps/orders/src/**'] },
      'type:feature': { match: ['apps/orders/src/**'] },
      'scope:shared': { match: ['libs/shared-ui/**'] },
      'type:ui': { match: ['libs/shared-ui/**'] },
    });
  });

  it('ignores project.json files under node_modules', async () => {
    await writeJson(join(root, 'node_modules/some-lib/project.json'), {
      root: 'node_modules/some-lib',
      tags: ['scope:vendored'],
    });

    const result = await importNxBoundaries(root, typescript);
    expect(result).toBeUndefined();
  });

  it('builds boundaries from .eslintrc.json depConstraints', async () => {
    await writeJson(join(root, 'apps/orders/project.json'), { root: 'apps/orders', tags: ['scope:orders'] });
    await writeJson(join(root, 'libs/shared/project.json'), { root: 'libs/shared', tags: ['scope:shared'] });
    await writeJson(join(root, '.eslintrc.json'), {
      rules: {
        '@nx/enforce-module-boundaries': [
          'error',
          {
            depConstraints: [{ sourceTag: 'scope:orders', onlyDependOnLibsWithTags: ['scope:shared'] }],
          },
        ],
      },
    });

    const result = await importNxBoundaries(root, typescript);
    expect(result?.boundaries).toEqual({ 'scope:orders': { may_depend_on: ['scope:shared'] } });
  });

  it('builds boundaries from a flat eslint.config.js via AST (never executing it)', async () => {
    await writeJson(join(root, 'apps/orders/project.json'), { root: 'apps/orders', tags: ['scope:orders'] });
    await writeJson(join(root, 'libs/shared/project.json'), { root: 'libs/shared', tags: ['scope:shared'] });
    await writeFile(
      join(root, 'eslint.config.js'),
      [
        "throw new Error('this must never run');",
        'export default [',
        '  {',
        '    rules: {',
        "      '@nx/enforce-module-boundaries': [",
        "        'error',",
        '        {',
        '          depConstraints: [',
        "            { sourceTag: 'scope:orders', onlyDependOnLibsWithTags: ['scope:shared'] },",
        '          ],',
        '        },',
        '      ],',
        '    },',
        '  },',
        '];',
        '',
      ].join('\n'),
      'utf8',
    );

    const result = await importNxBoundaries(root, typescript);
    expect(result?.boundaries).toEqual({ 'scope:orders': { may_depend_on: ['scope:shared'] } });
  });

  it('expands a wildcard onlyDependOnLibsWithTags to every discovered tag', async () => {
    await writeJson(join(root, 'apps/orders/project.json'), { root: 'apps/orders', tags: ['scope:orders'] });
    await writeJson(join(root, 'libs/shared/project.json'), { root: 'libs/shared', tags: ['scope:shared'] });
    await writeJson(join(root, '.eslintrc.json'), {
      rules: {
        '@nx/enforce-module-boundaries': [
          'error',
          { depConstraints: [{ sourceTag: 'scope:orders', onlyDependOnLibsWithTags: ['*'] }] },
        ],
      },
    });

    const result = await importNxBoundaries(root, typescript);
    expect(result?.boundaries['scope:orders']?.may_depend_on.sort()).toEqual(['scope:orders', 'scope:shared']);
  });

  it('warns instead of guessing at a wildcard sourceTag', async () => {
    await writeJson(join(root, 'apps/orders/project.json'), { root: 'apps/orders', tags: ['scope:orders'] });
    await writeJson(join(root, '.eslintrc.json'), {
      rules: {
        '@nx/enforce-module-boundaries': [
          'error',
          { depConstraints: [{ sourceTag: 'scope:*', onlyDependOnLibsWithTags: ['scope:shared'] }] },
        ],
      },
    });

    const result = await importNxBoundaries(root, typescript);
    expect(result?.boundaries).toEqual({});
    expect(result?.warnings.some((w) => w.includes('scope:*'))).toBe(true);
  });
});
