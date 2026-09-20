import { describe, expect, it } from 'vitest';

import { InvalidInputError } from '../../src/tools/internal/errors.js';
import { getTemplateBindingsTool } from '../../src/tools/get_template_bindings.js';

import { buildFixture } from './internal/fixture.js';

describe('angular_get_template_bindings', () => {
  it('classifies an interpolation binding and resolves it to the component\'s own signal', async () => {
    const { context, ids } = buildFixture();
    const output = await getTemplateBindingsTool.run({ ref: ids.userListComponent, format: 'json' }, context);

    expect(output.templatePath).toBe(ids.userListComponent.split('#')[0]);
    if (output.result.format !== 'json') throw new Error('expected json');

    const binding = output.result.data.items.find((item) => item.kind === 'interpolation');
    expect(binding).toBeDefined();
    expect(binding?.detail?.memberName).toBe('count');
    expect(binding?.detail?.resolved).toBe(true);
    expect(binding?.detail?.resolvedTypeText).toBe('number');
  });

  it('lists the elements/directives/pipes the template resolves to', async () => {
    const { context, ids } = buildFixture();
    const output = await getTemplateBindingsTool.run({ ref: ids.appComponent, format: 'json' }, context);

    if (output.result.format !== 'json') throw new Error('expected json');
    const uses = output.result.data.items.find((item) => item.kind === 'UsesInTemplate');
    expect(uses?.detail?.selector).toBe('app-user-list');
    expect(uses?.detail?.resolvedKind).toBe('Component');
  });

  it('throws an actionable error for a component with no renders edge (no indexed template)', async () => {
    const { context, ids } = buildFixture();
    await expect(getTemplateBindingsTool.run({ ref: ids.adminUserListComponent }, context)).rejects.toBeInstanceOf(InvalidInputError);
  });
});
