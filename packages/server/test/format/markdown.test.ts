import { describe, expect, it } from 'vitest';

import { renderMarkdown } from '../../src/format/markdown.js';
import { paginate } from '../../src/format/paginate.js';
import type { Fact } from '../../src/format/types.js';

function fact(overrides: Partial<Fact> = {}): Fact {
  return {
    kind: 'Component',
    summary: 'UserListComponent',
    provenance: { file: 'src/app/user-list.component.ts', line: 12 },
    confidence: 'certain',
    ...overrides,
  };
}

describe('renderMarkdown', () => {
  it('renders each fact with its file and line', () => {
    const page = paginate([fact()]);
    const result = renderMarkdown(page);
    expect(result.text).toContain('src/app/user-list.component.ts:12');
  });

  it('falls back to the file alone when there is no line', () => {
    const page = paginate([fact({ provenance: { file: 'src/app/user.ts' } })]);
    const result = renderMarkdown(page);
    expect(result.text).toContain('src/app/user.ts');
    expect(result.text).not.toMatch(/user\.ts:\d/);
  });

  it('marks an inferred fact', () => {
    const page = paginate([fact({ confidence: 'inferred' })]);
    const result = renderMarkdown(page);
    expect(result.text).toMatch(/inferido/);
  });

  it('marks an unknown-confidence fact', () => {
    const page = paginate([fact({ confidence: 'unknown' })]);
    const result = renderMarkdown(page);
    expect(result.text).toMatch(/desconocido/);
  });

  it('does not mark a certain fact as inferred or unknown', () => {
    const page = paginate([fact({ confidence: 'certain' })]);
    const result = renderMarkdown(page);
    expect(result.text).not.toMatch(/inferido|desconocido/);
  });

  it('shows pagination metadata: how many are shown out of the total', () => {
    const items = Array.from({ length: 30 }, (_, i) => fact({ summary: `Fact ${i}` }));
    const page = paginate(items, { limit: 10, offset: 0 });
    const result = renderMarkdown(page);
    expect(result.text).toContain('1-10 de 30');
    expect(result.text).toContain('offset=10');
  });

  it('reports no results explicitly for an empty page', () => {
    const page = paginate([]);
    const result = renderMarkdown(page);
    expect(result.text).toMatch(/sin resultados/i);
    expect(result.truncated).toBe(false);
  });

  it('is truncated when the rendered page exceeds 8 KB', () => {
    const items = Array.from({ length: 2000 }, (_, i) =>
      fact({ summary: `Componente numero ${i} con una descripcion bien larga para inflar el tamano` }),
    );
    const page = paginate(items, { limit: 2000, offset: 0 });
    const result = renderMarkdown(page);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.text, 'utf8')).toBeLessThanOrEqual(8 * 1024);
  });
});
