import { describe, expect, it } from 'vitest';

import { listHttpCallsTool } from '../../src/tools/list_http_calls.js';
import { AmbiguousRefError } from '../../src/tools/internal/errors.js';

import { AMBIGUOUS_NAME, buildFixture } from './internal/fixture.js';

describe('angular_list_http_calls', () => {
  it('lists every indexed HTTP call', async () => {
    const { context } = buildFixture();
    const output = await listHttpCallsTool.run({ format: 'json' }, context);

    expect(output.totalCalls).toBe(1);
    if (output.result.format !== 'json') throw new Error('expected json');
    expect(output.result.data.items[0]?.detail?.urlPattern).toBe('/api/users');
    expect(output.result.data.items[0]?.confidence).toBe('certain');
  });

  it('filters by method', async () => {
    const { context } = buildFixture();
    const matching = await listHttpCallsTool.run({ method: 'get', format: 'json' }, context);
    expect(matching.matchedCalls).toBe(1);

    const nonMatching = await listHttpCallsTool.run({ method: 'post', format: 'json' }, context);
    expect(nonMatching.matchedCalls).toBe(0);
  });

  it('filters by url_pattern substring', async () => {
    const { context } = buildFixture();
    const output = await listHttpCallsTool.run({ url_pattern: 'users', format: 'json' }, context);
    expect(output.matchedCalls).toBe(1);

    const empty = await listHttpCallsTool.run({ url_pattern: 'nope', format: 'json' }, context);
    expect(empty.matchedCalls).toBe(0);
  });

  it('filters by caller, resolved the same way as other ref-taking tools (R13)', async () => {
    const { context, ids } = buildFixture();
    const output = await listHttpCallsTool.run({ caller: ids.userService, format: 'json' }, context);
    expect(output.matchedCalls).toBe(1);

    await expect(listHttpCallsTool.run({ caller: AMBIGUOUS_NAME }, context)).rejects.toBeInstanceOf(AmbiguousRefError);
  });
});
