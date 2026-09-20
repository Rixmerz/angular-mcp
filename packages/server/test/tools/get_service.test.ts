import { describe, expect, it } from 'vitest';

import { getServiceTool } from '../../src/tools/get_service.js';
import { RefNotFoundError } from '../../src/tools/internal/errors.js';

import { buildFixture } from './internal/fixture.js';

describe('angular_get_service', () => {
  it('returns identity fields and providedIn', async () => {
    const { context, ids } = buildFixture();
    const output = await getServiceTool.run({ ref: ids.userService, format: 'json' }, context);

    expect(output.id).toBe(ids.userService);
    expect(output.providedIn).toBe('root');
    expect(output.isInjectable).toBe(true);
  });

  it('lists who injects it, its own HTTP calls, and its specs', async () => {
    const { context, ids } = buildFixture();
    const output = await getServiceTool.run({ ref: ids.userService, format: 'json', limit: 100 }, context);
    if (output.result.format !== 'json') throw new Error('expected json');

    const kinds = output.result.data.items.map((item) => item.kind);
    expect(kinds).toContain('InjectedInto');
    expect(kinds).toContain('HttpCall');
    expect(kinds).toContain('Spec');
  });

  it('rejects a ref that resolves to a non-Service node', async () => {
    const { context, ids } = buildFixture();
    await expect(getServiceTool.run({ ref: ids.userListComponent }, context)).rejects.toBeInstanceOf(RefNotFoundError);
  });
});
