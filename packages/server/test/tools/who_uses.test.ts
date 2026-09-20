import { describe, expect, it } from 'vitest';

import { whoUsesTool } from '../../src/tools/who_uses.js';

import { buildFixture } from './internal/fixture.js';

describe('angular_who_uses', () => {
  it('lists the template that uses a component', async () => {
    const { context, ids } = buildFixture();
    const output = await whoUsesTool.run({ ref: ids.userListComponent, format: 'json' }, context);

    if (output.result.format !== 'json') throw new Error('expected json');
    expect(output.result.data.items.some((item) => item.kind === 'uses_in_template')).toBe(true);
  });

  it('lists who injects a service', async () => {
    const { context, ids } = buildFixture();
    const output = await whoUsesTool.run({ ref: ids.userService, format: 'json' }, context);

    if (output.result.format !== 'json') throw new Error('expected json');
    expect(output.result.data.items.some((item) => item.kind === 'injects')).toBe(true);
  });

  it('lists who routes to a component', async () => {
    const { context, ids } = buildFixture();
    const output = await whoUsesTool.run({ ref: ids.userListComponent, format: 'json' }, context);

    if (output.result.format !== 'json') throw new Error('expected json');
    expect(output.result.data.items.some((item) => item.kind === 'routes_to')).toBe(true);
  });

  it('filters to one relationship kind with "via"', async () => {
    const { context, ids } = buildFixture();
    const output = await whoUsesTool.run({ ref: ids.userListComponent, via: 'injects', format: 'json' }, context);

    if (output.result.format !== 'json') throw new Error('expected json');
    expect(output.result.data.items).toEqual([]);
  });

  it('resolves a ref regardless of node kind (a Service, not just a Component)', async () => {
    const { context, ids } = buildFixture();
    const output = await whoUsesTool.run({ ref: ids.userService, format: 'json' }, context);
    expect(output.kind).toBe('Service');
  });
});
