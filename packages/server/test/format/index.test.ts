import { describe, expect, it } from 'vitest';

import { formatFacts } from '../../src/format/index.js';
import type { Fact } from '../../src/format/types.js';

function facts(n: number): Fact[] {
  return Array.from({ length: n }, (_, i) => ({
    kind: 'Component',
    summary: `Component ${i}`,
    provenance: { file: `src/app/c${i}.component.ts`, line: 1 },
    confidence: 'certain' as const,
  }));
}

describe('formatFacts', () => {
  it('defaults to markdown', () => {
    const result = formatFacts(facts(3));
    expect(result.format).toBe('markdown');
  });

  it('supports the json format', () => {
    const result = formatFacts(facts(3), { format: 'json' });
    expect(result.format).toBe('json');
    if (result.format === 'json') {
      expect(result.data.items).toHaveLength(3);
      expect(result.data.pagination.total_count).toBe(3);
    }
  });

  it('applies limit/offset and reports pagination metadata for json', () => {
    const result = formatFacts(facts(50), { format: 'json', limit: 10, offset: 20 });
    if (result.format !== 'json') throw new Error('expected json');
    expect(result.data.items).toHaveLength(10);
    expect(result.data.pagination).toEqual({
      limit: 10,
      offset: 20,
      total_count: 50,
      has_more: true,
      next_offset: 30,
    });
  });

  it('does not truncate json even for a very large fact set', () => {
    const result = formatFacts(facts(5000), { format: 'json', limit: 5000 });
    if (result.format !== 'json') throw new Error('expected json');
    expect(result.data.items).toHaveLength(5000);
  });

  it('truncates markdown at 8 KB and says so', () => {
    const result = formatFacts(facts(5000), { limit: 5000 });
    if (result.format !== 'markdown') throw new Error('expected markdown');
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.text, 'utf8')).toBeLessThanOrEqual(8 * 1024);
    expect(result.text).toMatch(/truncat/i);
  });

  it('reports has_more/next_offset consistently across markdown and json for the same page', () => {
    const markdown = formatFacts(facts(30), { limit: 20, offset: 0 });
    const json = formatFacts(facts(30), { format: 'json', limit: 20, offset: 0 });
    if (json.format !== 'json') throw new Error('expected json');
    expect(json.data.pagination.has_more).toBe(true);
    expect(json.data.pagination.next_offset).toBe(20);
    if (markdown.format !== 'markdown') throw new Error('expected markdown');
    expect(markdown.text).toContain('offset=20');
  });
});
