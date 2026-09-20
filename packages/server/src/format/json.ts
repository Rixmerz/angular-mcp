/**
 * Renderizado JSON: la forma completa, para procesamiento. Ver
 * docs/PLAN.md, seccion 6 ("JSON completo solo bajo peticion"). A
 * diferencia de markdown, no se trunca ni se resume.
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
