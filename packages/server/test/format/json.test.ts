import { describe, expect, it } from 'vitest';

import { renderJson } from '../../src/format/json.js';
import { paginate } from '../../src/format/paginate.js';
import type { Fact } from '../../src/format/types.js';

function fact(): Fact {
  return {
    kind: 'Service',
    summary: 'UserService',
    provenance: { file: 'src/app/user.service.ts', line: 5, column: 1 },
    confidence: 'certain',
    detail: { providedIn: 'root', isInjectable: true },
  };
}

describe('renderJson', () => {
  it('carries the full fact, including detail, untouched', () => {
    const page = paginate([fact()]);
    const { items } = renderJson(page);
    expect(items[0]).toEqual(fact());
  });

  it('includes limit, offset, total_count, has_more and next_offset', () => {
    const items = Array.from({ length: 45 }, () => fact());
    const page = paginate(items, { limit: 20, offset: 20 });
    const { pagination } = renderJson(page);

    expect(pagination).toEqual({
      limit: 20,
      offset: 20,
      total_count: 45,
      has_more: true,
      next_offset: 40,
    });
  });

  it('is not truncated regardless of size (full form is JSON-only)', () => {
    const items = Array.from({ length: 5000 }, () => fact());
    const page = paginate(items, { limit: 5000 });
    const { items: renderedItems } = renderJson(page);
    expect(renderedItems).toHaveLength(5000);
  });
});
