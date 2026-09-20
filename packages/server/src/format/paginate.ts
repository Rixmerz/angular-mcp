/**
 * Paginacion generica. Ver docs/PLAN.md, seccion 6: "Toda herramienta que
 * lista acepta `limit` (default 20), `offset`" y riesgo R6.
 */

export const DEFAULT_LIMIT = 20;

export interface PageParams {
  readonly limit?: number;
  readonly offset?: number;
}

export interface Pagination {
  readonly limit: number;
  readonly offset: number;
  readonly total_count: number;
  readonly has_more: boolean;
  readonly next_offset: number | null;
}

export interface Page<T> extends Pagination {
  readonly items: readonly T[];
}

/** Aplica limit/offset a `items` y calcula los metadatos de paginacion. */
export function paginate<T>(items: readonly T[], params: PageParams = {}): Page<T> {
  const limit = normalizeNonNegativeInt(params.limit, DEFAULT_LIMIT, 'limit');
  const offset = normalizeNonNegativeInt(params.offset, 0, 'offset');

  const total_count = items.length;
  const pageItems = items.slice(offset, offset + limit);
  const consumed = offset + pageItems.length;
  const has_more = consumed < total_count;

  return {
    items: pageItems,
    limit,
    offset,
    total_count,
    has_more,
    next_offset: has_more ? consumed : null,
  };
}

function normalizeNonNegativeInt(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`paginate: ${name} debe ser un entero >= 0, recibido ${value}`);
  }
  return value;
}
