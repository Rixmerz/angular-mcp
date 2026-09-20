/**
 * JSON rendering: the full shape, meant for programmatic processing. See
 * docs/PLAN.md, section 6 ("full JSON only on request"). Unlike markdown, it is
 * never truncated nor summarized.
 */

import type { Page, Pagination } from './paginate.js';
import type { Fact } from './types.js';

export interface JsonResponse {
  readonly items: readonly Fact[];
  readonly pagination: Pagination;
}

export function renderJson(page: Page<Fact>): JsonResponse {
  const { items, ...pagination } = page;
  return { items, pagination };
}
