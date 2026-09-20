import { describe, expect, it } from 'vitest';

import { RulesFileSchema } from '../../src/rules/schema.js';

const EXAMPLE_FROM_PLAN = {
  version: 1,
  layers: {
    ui: { match: ['src/app/**/*.component.ts', 'src/app/**/*.directive.ts'] },
    state: { match: ['src/app/**/*.store.ts', 'src/app/**/state/**'] },
    data: { match: ['src/app/**/*.service.ts', 'src/app/**/data/**'] },
    domain: { match: ['src/app/**/domain/**'] },
    shared: { match: ['src/app/shared/**'] },
  },
  boundaries: {
    ui: { may_depend_on: ['state', 'data', 'domain', 'shared'] },
    state: { may_depend_on: ['data', 'domain', 'shared'] },
    data: { may_depend_on: ['domain', 'shared'] },
    domain: { may_depend_on: ['shared'] },
    shared: { may_depend_on: [] },
  },
  constraints: [
    {
      id: 'no-http-in-components',
      description: 'Components do not make direct HTTP calls.',
      forbid: { edge: 'calls_http', from: 'Component' },
    },
    {
      id: 'services-own-http',
      description: 'Only services in the data layer call HttpClient.',
      forbid: { edge: 'calls_http', from_layer_not: 'data' },
    },
    {
      id: 'onpush-required',
      description: 'Every component uses OnPush.',
      require: { node: 'Component', attr: 'changeDetection', equals: 'OnPush' },
      severity: 'warning',
    },
  ],
  decisions: [
    {
      id: 'pagination-server-side',
      text: 'Pagination is always done server-side.',
      applies_to: ['src/app/**/*-list.component.ts'],
    },
  ],
};

describe('RulesFileSchema', () => {
  it('accepts the example from docs/PLAN.md section 5.3 verbatim', () => {
    const result = RulesFileSchema.safeParse(EXAMPLE_FROM_PLAN);
    expect(result.success).toBe(true);
  });

  it('defaults severity to "error" when omitted', () => {
    const result = RulesFileSchema.parse({
      version: 1,
      constraints: [
        { id: 'c1', description: 'd', forbid: { edge: 'calls_http', from: 'Component' } },
      ],
    });
    expect(result.constraints[0]?.severity).toBe('error');
  });

  it('defaults layers, boundaries, constraints and decisions to empty', () => {
    const result = RulesFileSchema.parse({ version: 1 });
    expect(result.layers).toEqual({});
    expect(result.boundaries).toEqual({});
    expect(result.constraints).toEqual([]);
    expect(result.decisions).toEqual([]);
  });

  it('rejects a version other than 1', () => {
    const result = RulesFileSchema.safeParse({ version: 2 });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown top-level key', () => {
    const result = RulesFileSchema.safeParse({ version: 1, unknownKey: true });
    expect(result.success).toBe(false);
  });

  it('rejects a layer with no match globs', () => {
    const result = RulesFileSchema.safeParse({ version: 1, layers: { ui: { match: [] } } });
    expect(result.success).toBe(false);
  });

  it('rejects a constraint with neither forbid nor require', () => {
    const result = RulesFileSchema.safeParse({
      version: 1,
      constraints: [{ id: 'c1', description: 'd' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a constraint with both forbid and require', () => {
    const result = RulesFileSchema.safeParse({
      version: 1,
      constraints: [
        {
          id: 'c1',
          description: 'd',
          forbid: { edge: 'calls_http', from: 'Component' },
          require: { node: 'Component', attr: 'changeDetection', equals: 'OnPush' },
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a "forbid" with neither "from" nor "from_layer_not"', () => {
    const result = RulesFileSchema.safeParse({
      version: 1,
      constraints: [{ id: 'c1', description: 'd', forbid: { edge: 'calls_http' } }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown edge kind in "forbid"', () => {
    const result = RulesFileSchema.safeParse({
      version: 1,
      constraints: [{ id: 'c1', description: 'd', forbid: { edge: 'not_a_real_edge', from: 'Component' } }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown node kind in "require"', () => {
    const result = RulesFileSchema.safeParse({
      version: 1,
      constraints: [
        { id: 'c1', description: 'd', require: { node: 'NotARealNode', attr: 'x', equals: 1 } },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects duplicate constraint ids', () => {
    const result = RulesFileSchema.safeParse({
      version: 1,
      constraints: [
        { id: 'dup', description: 'a', forbid: { edge: 'calls_http', from: 'Component' } },
        { id: 'dup', description: 'b', forbid: { edge: 'calls_http', from: 'Component' } },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects duplicate decision ids', () => {
    const result = RulesFileSchema.safeParse({
      version: 1,
      decisions: [
        { id: 'dup', text: 'a' },
        { id: 'dup', text: 'b' },
      ],
    });
    expect(result.success).toBe(false);
  });
});
