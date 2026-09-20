import { describe, expect, it } from 'vitest';

import { getComponentTool } from '../../src/tools/get_component.js';
import { AmbiguousRefError, RefNotFoundError } from '../../src/tools/internal/errors.js';

import { AMBIGUOUS_NAME, buildFixture } from './internal/fixture.js';

describe('angular_get_component', () => {
  it('resolves a full ref and returns identity fields', async () => {
    const { context, ids } = buildFixture();
    const output = await getComponentTool.run({ ref: ids.userListComponent, format: 'json' }, context);

    expect(output.id).toBe(ids.userListComponent);
    expect(output.selector).toBe('app-user-list');
    expect(output.standalone).toBe(true);
    expect(output.changeDetection).toBe('OnPush');
  });

  it('resolves an unambiguous bare name', async () => {
    const { context, ids } = buildFixture();
    const output = await getComponentTool.run({ ref: 'UserListComponent', format: 'json' }, context);
    expect(output.id).toBe(ids.userListComponent);
  });

  it('throws AmbiguousRefError, with every candidate, for a bare name matching more than one component (R13)', async () => {
    const { context } = buildFixture();

    await expect(getComponentTool.run({ ref: AMBIGUOUS_NAME }, context)).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(AmbiguousRefError);
      const ambiguous = error as AmbiguousRefError;
      expect(ambiguous.candidates).toHaveLength(2);
      expect(ambiguous.candidates.map((c) => c.path).sort()).toEqual([
        'src/app/one/duplicate-name.component.ts',
        'src/app/two/duplicate-name.component.ts',
      ]);
      return true;
    });
  });

  it('throws RefNotFoundError for an unknown ref', async () => {
    const { context } = buildFixture();
    await expect(getComponentTool.run({ ref: 'src/nope.ts#Nope' }, context)).rejects.toBeInstanceOf(RefNotFoundError);
  });

  it('includes inputs, signals, dependencies, template, consumers, routes and specs', async () => {
    const { context, ids } = buildFixture();
    const output = await getComponentTool.run({ ref: ids.userListComponent, format: 'json', limit: 100 }, context);
    if (output.result.format !== 'json') throw new Error('expected json');

    const kinds = output.result.data.items.map((item) => item.kind);
    expect(kinds).toContain('Input');
    expect(kinds).toContain('Output');
    expect(kinds).toContain('Signal');
    expect(kinds).toContain('LifecycleHooks');
    expect(kinds).toContain('Dependency');
    expect(kinds).toContain('Template');
    expect(kinds).toContain('UsedInTemplate');
    expect(kinds).toContain('Route');
    expect(kinds).toContain('HttpCall');
  });

  it('bounds the reachable HTTP traversal by "depth"', async () => {
    const { context, ids } = buildFixture();
    const shallow = await getComponentTool.run({ ref: ids.userListComponent, format: 'json', depth: 0, limit: 100 }, context);
    if (shallow.result.format !== 'json') throw new Error('expected json');
    expect(shallow.result.data.items.some((item) => item.kind === 'HttpCall')).toBe(false);

    const deep = await getComponentTool.run({ ref: ids.userListComponent, format: 'json', depth: 3, limit: 100 }, context);
    if (deep.result.format !== 'json') throw new Error('expected json');
    expect(deep.result.data.items.some((item) => item.kind === 'HttpCall')).toBe(true);
  });

  it('marks a literal HTTP call as certain and reports its urlConfidence-derived confidence', async () => {
    const { context, ids } = buildFixture();
    const output = await getComponentTool.run({ ref: ids.userListComponent, format: 'json', limit: 100 }, context);
    if (output.result.format !== 'json') throw new Error('expected json');

    const httpFact = output.result.data.items.find((item) => item.kind === 'HttpCall');
    expect(httpFact?.confidence).toBe('certain');
  });
});
