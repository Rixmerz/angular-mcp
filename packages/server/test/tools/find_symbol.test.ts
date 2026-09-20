import { describe, expect, it } from 'vitest';

import { findSymbolTool } from '../../src/tools/find_symbol.js';

import { AMBIGUOUS_NAME, buildFixture } from './internal/fixture.js';

describe('angular_find_symbol', () => {
  it('finds an exact-name match and ranks it first', async () => {
    const { context } = buildFixture();
    const output = await findSymbolTool.run({ query: 'UserListComponent', format: 'json' }, context);

    expect(output.matchCount).toBeGreaterThanOrEqual(1);
    if (output.result.format !== 'json') throw new Error('expected json');
    expect(output.result.data.items[0]?.detail?.name).toBe('UserListComponent');
  });

  it('matches by selector', async () => {
    const { context } = buildFixture();
    const output = await findSymbolTool.run({ query: 'app-user-list', format: 'json' }, context);

    if (output.result.format !== 'json') throw new Error('expected json');
    expect(output.result.data.items.some((item) => item.detail?.id === 'src/app/user-list/user-list.component.ts#UserListComponent')).toBe(true);
  });

  it('restricts by kind', async () => {
    const { context } = buildFixture();
    const output = await findSymbolTool.run({ query: 'User', kind: 'Service', format: 'json' }, context);

    if (output.result.format !== 'json') throw new Error('expected json');
    expect(output.result.data.items.length).toBeGreaterThan(0);
    expect(output.result.data.items.every((item) => item.kind === 'Service')).toBe(true);
  });

  it('returns every candidate for an ambiguous name rather than guessing (R13)', async () => {
    const { context } = buildFixture();
    const output = await findSymbolTool.run({ query: AMBIGUOUS_NAME, format: 'json' }, context);

    if (output.result.format !== 'json') throw new Error('expected json');
    const ids = output.result.data.items.map((item) => item.detail?.id);
    expect(ids).toContain('src/app/one/duplicate-name.component.ts#DuplicateNameComponent');
    expect(ids).toContain('src/app/two/duplicate-name.component.ts#DuplicateNameComponent');
  });

  it('returns an empty list, never an error, for no matches', async () => {
    const { context } = buildFixture();
    const output = await findSymbolTool.run({ query: 'NoSuchThing', format: 'json' }, context);

    expect(output.matchCount).toBe(0);
    if (output.result.format !== 'json') throw new Error('expected json');
    expect(output.result.data.items).toEqual([]);
  });

  it('has readOnlyHint true and the other read-only annotations', () => {
    expect(findSymbolTool.annotations).toEqual({
      title: 'Find symbol',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  });
});
