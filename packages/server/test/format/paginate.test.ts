import { describe, expect, it } from 'vitest';

import { DEFAULT_LIMIT, paginate } from '../../src/format/paginate.js';

function items(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}

describe('paginate', () => {
  it('defaults to limit 20 and offset 0', () => {
    const page = paginate(items(25));
    expect(page.limit).toBe(DEFAULT_LIMIT);
    expect(page.offset).toBe(0);
    expect(page.items).toEqual(items(20));
  });

  it('applies a custom limit and offset', () => {
    const page = paginate(items(10), { limit: 3, offset: 4 });
    expect(page.items).toEqual([4, 5, 6]);
  });

  it('reports total_count as the full collection size, not the page size', () => {
    const page = paginate(items(50), { limit: 5, offset: 10 });
    expect(page.total_count).toBe(50);
  });

  it('sets has_more and next_offset when more items remain', () => {
    const page = paginate(items(50), { limit: 5, offset: 10 });
    expect(page.has_more).toBe(true);
    expect(page.next_offset).toBe(15);
  });

  it('sets has_more false and next_offset null on the last page', () => {
    const page = paginate(items(10), { limit: 5, offset: 5 });
    expect(page.has_more).toBe(false);
    expect(page.next_offset).toBeNull();
  });

  it('sets has_more false when offset is past the end', () => {
    const page = paginate(items(3), { limit: 5, offset: 10 });
    expect(page.items).toEqual([]);
    expect(page.has_more).toBe(false);
    expect(page.next_offset).toBeNull();
    expect(page.total_count).toBe(3);
  });

  it('treats limit 0 as an empty page that still reports total_count', () => {
    const page = paginate(items(5), { limit: 0 });
    expect(page.items).toEqual([]);
    expect(page.total_count).toBe(5);
    expect(page.has_more).toBe(true);
    expect(page.next_offset).toBe(0);
  });

  it('rejects a negative limit', () => {
    expect(() => paginate(items(5), { limit: -1 })).toThrow();
  });

  it('rejects a negative offset', () => {
    expect(() => paginate(items(5), { offset: -1 })).toThrow();
  });

  it('rejects a non-integer limit', () => {
    expect(() => paginate(items(5), { limit: 1.5 })).toThrow();
  });
});
