import * as typescript from 'typescript';
import { describe, expect, it } from 'vitest';

import type { EffectiveRules } from '../../../src/rules/load.js';
import { RulesFileSchema } from '../../../src/rules/schema.js';
import { explainLayer } from '../../../src/rules/tools/explain-layer.js';

const EFFECTIVE_RULES: EffectiveRules = {
  rules: RulesFileSchema.parse({
    version: 1,
    layers: {
      ui: { match: ['src/app/**/*.component.ts'] },
      data: { match: ['src/app/**/*.service.ts'] },
    },
    boundaries: {
      ui: { may_depend_on: ['data'] },
      data: { may_depend_on: [] },
    },
  }),
  layerOrigin: { ui: 'own', data: 'nx' },
  warnings: [],
};

describe('explainLayer', () => {
  it('explains which layer a file belongs to, its origin, and what it may depend on', async () => {
    const result = await explainLayer(
      { root: '/repo', file: 'src/app/user.service.ts' },
      { typescript, effectiveRules: EFFECTIVE_RULES },
    );

    expect(result.layer).toBe('data');
    expect(result.origin).toBe('nx');
    expect(result.matchedGlob).toBe('src/app/**/*.service.ts');
    expect(result.mayDependOn).toEqual([]);
    expect(result.reason).toContain('data');
  });

  it('explains a file that matches no layer', async () => {
    const result = await explainLayer(
      { root: '/repo', file: 'src/main.ts' },
      { typescript, effectiveRules: EFFECTIVE_RULES },
    );

    expect(result.layer).toBeUndefined();
    expect(result.mayDependOn).toEqual([]);
    expect(result.reason).toContain('No layer');
  });
});
