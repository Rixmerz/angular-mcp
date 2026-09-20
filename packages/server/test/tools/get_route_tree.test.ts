import { describe, expect, it } from 'vitest';

import { getRouteTreeTool } from '../../src/tools/get_route_tree.js';
import { InvalidInputError } from '../../src/tools/internal/errors.js';

import { buildFixture } from './internal/fixture.js';

describe('angular_get_route_tree', () => {
  it('lists every route with its joined full path', async () => {
    const { context } = buildFixture();
    const output = await getRouteTreeTool.run({ format: 'json', limit: 100 }, context);

    expect(output.totalRoutes).toBe(3);
    if (output.result.format !== 'json') throw new Error('expected json');
    const fullPaths = output.result.data.items.map((item) => item.detail?.fullPath);
    expect(fullPaths).toContain('users');
    expect(fullPaths).toContain('admin');
    expect(fullPaths).toContain('admin/users');
  });

  it('includes guards and resolvers on the nested route', async () => {
    const { context, ids } = buildFixture();
    const output = await getRouteTreeTool.run({ format: 'json', limit: 100 }, context);
    if (output.result.format !== 'json') throw new Error('expected json');

    const nested = output.result.data.items.find((item) => item.detail?.id === ids.routeAdminUsers);
    expect(nested?.detail?.guards).toEqual([ids.guard]);
    expect(nested?.detail?.resolvers).toEqual([ids.resolver]);
    expect(nested?.detail?.parentId).toBe(ids.routeAdmin);
  });

  it('filters by path_prefix', async () => {
    const { context } = buildFixture();
    const output = await getRouteTreeTool.run({ path_prefix: 'admin', format: 'json', limit: 100 }, context);
    if (output.result.format !== 'json') throw new Error('expected json');

    const fullPaths = output.result.data.items.map((item) => item.detail?.fullPath).sort();
    expect(fullPaths).toEqual(['admin', 'admin/users']);
  });

  it('filters by project, using the workspace layout', async () => {
    const { context } = buildFixture();
    const output = await getRouteTreeTool.run({ project: 'admin', format: 'json', limit: 100 }, context);
    if (output.result.format !== 'json') throw new Error('expected json');

    const fullPaths = output.result.data.items.map((item) => item.detail?.fullPath);
    expect(fullPaths).toEqual(['admin/users']);
  });

  it('rejects an unknown project name with the list of known ones', async () => {
    const { context } = buildFixture();
    await expect(getRouteTreeTool.run({ project: 'does-not-exist' }, context)).rejects.toBeInstanceOf(InvalidInputError);
  });

  it('bounds nesting with "depth"', async () => {
    const { context } = buildFixture();
    const output = await getRouteTreeTool.run({ depth: 0, format: 'json', limit: 100 }, context);
    if (output.result.format !== 'json') throw new Error('expected json');

    const fullPaths = output.result.data.items.map((item) => item.detail?.fullPath).sort();
    expect(fullPaths).toEqual(['admin', 'users']);
  });
});
