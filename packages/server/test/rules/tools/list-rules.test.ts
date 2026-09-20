import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as typescript from 'typescript';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { EffectiveRules } from '../../../src/rules/load.js';
import { RulesFileSchema } from '../../../src/rules/schema.js';
import { listRules } from '../../../src/rules/tools/list-rules.js';

describe('listRules', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'list-rules-'));
    await mkdir(join(root, 'src/app'), { recursive: true });
    await writeFile(join(root, 'src/app/user-list.component.ts'), 'export class UserListComponent {}\n', 'utf8');
    await writeFile(join(root, 'src/app/user.service.ts'), 'export class UserService {}\n', 'utf8');
    await writeFile(join(root, 'README.md'), '# demo\n', 'utf8');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('reports the origin of every layer and resolves a layer per file', async () => {
    const effectiveRules: EffectiveRules = {
      rules: RulesFileSchema.parse({
        version: 1,
        layers: { ui: { match: ['src/app/**/*.component.ts'] }, data: { match: ['src/app/**/*.service.ts'] } },
      }),
      layerOrigin: { ui: 'own', data: 'sheriff' },
      warnings: ['a warning from an importer'],
    };

    const result = await listRules({ root, format: 'json' }, { typescript, effectiveRules });

    expect(result.layerOrigin).toEqual({ ui: 'own', data: 'sheriff' });
    expect(result.warnings).toEqual(['a warning from an importer']);
    expect(result.response.format).toBe('json');

    const items = result.response.format === 'json' ? result.response.data.items : [];
    const byPath = new Map(items.map((item) => [(item.detail as { path: string }).path, item]));
    expect((byPath.get('src/app/user-list.component.ts')?.detail as { layer: string }).layer).toBe('ui');
    expect((byPath.get('src/app/user.service.ts')?.detail as { layer: string }).layer).toBe('data');
    expect((byPath.get('README.md')?.detail as { layer: string | null }).layer).toBeNull();
  });
});
