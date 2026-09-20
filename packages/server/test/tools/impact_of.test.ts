import { describe, expect, it } from 'vitest';

import { impactOfTool } from '../../src/tools/impact_of.js';
import { InvalidInputError } from '../../src/tools/internal/errors.js';

import { AMBIGUOUS_NAME, buildFixture } from './internal/fixture.js';

describe('angular_impact_of', () => {
  it('requires at least one of "refs" or "files"', async () => {
    const { context } = buildFixture();
    await expect(impactOfTool.run({}, context)).rejects.toBeInstanceOf(InvalidInputError);
  });

  it('walks consumers upward and dependencies downward from a ref', async () => {
    const { context, ids } = buildFixture();
    const output = await impactOfTool.run({ refs: [ids.userService], format: 'json', limit: 100 }, context);

    expect(output.targets).toEqual([{ id: ids.userService, kind: 'Service', name: 'UserService', path: 'src/app/user.service.ts' }]);
    expect(output.consumerCount).toBeGreaterThan(0);
    expect(output.dependencyCount).toBeGreaterThan(0);

    if (output.result.format !== 'json') throw new Error('expected json');
    const consumerIds = output.result.data.items.filter((item) => item.detail?.role === 'consumer').map((item) => item.detail?.id);
    expect(consumerIds).toContain(ids.userListComponent);
  });

  it('reaches a consumer three hops away only when depth allows it', async () => {
    const { context, ids } = buildFixture();

    const shallow = await impactOfTool.run({ refs: [ids.userService], depth: 1, format: 'json', limit: 100 }, context);
    if (shallow.result.format !== 'json') throw new Error('expected json');
    const shallowIds = shallow.result.data.items.map((item) => item.detail?.id);
    expect(shallowIds).not.toContain(ids.appComponent);

    const deep = await impactOfTool.run({ refs: [ids.userService], depth: 3, format: 'json', limit: 100 }, context);
    if (deep.result.format !== 'json') throw new Error('expected json');
    const deepIds = deep.result.data.items.map((item) => item.detail?.id);
    expect(deepIds).toContain(ids.appComponent);
  });

  it('depth 0 walks no consumers/dependencies, but still reports the target\'s own direct spec', async () => {
    const { context, ids } = buildFixture();
    const output = await impactOfTool.run({ refs: [ids.userService], depth: 0, format: 'json', limit: 100 }, context);

    expect(output.consumerCount).toBe(0);
    expect(output.dependencyCount).toBe(0);
    expect(output.specCount).toBe(1);
    if (output.result.format !== 'json') throw new Error('expected json');
    expect(output.result.data.items.map((item) => item.detail?.id).sort()).toEqual(
      [ids.userService, ids.spec].sort(),
    );
  });

  it('resolves every symbol declared in a file when given "files"', async () => {
    const { context } = buildFixture();
    const output = await impactOfTool.run({ files: ['src/app/user.service.ts'], format: 'json', limit: 100 }, context);

    const targetIds = output.targets.map((t) => t.id);
    expect(targetIds).toEqual(expect.arrayContaining(['src/app/user.service.ts#UserService', 'src/app/user.service.ts#UserService.getUsers']));
  });

  it('reports the specs reached through a tested_by edge', async () => {
    const { context, ids } = buildFixture();
    const output = await impactOfTool.run({ refs: [ids.userService], format: 'json', limit: 100 }, context);
    expect(output.specCount).toBeGreaterThan(0);
  });

  it('wraps an ambiguous ref error with which ref caused it (R13)', async () => {
    const { context } = buildFixture();
    await expect(impactOfTool.run({ refs: [AMBIGUOUS_NAME] }, context)).rejects.toThrow(new RegExp(AMBIGUOUS_NAME));
  });
});
