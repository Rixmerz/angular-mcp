/**
 * Tipos de la capa de formato. Ver docs/PLAN.md, seccion 6 y riesgo R6.
 *
 * Las herramientas MCP no formatean directamente sus nodos/aristas del
 * grafo: las reducen a `Fact[]`, la forma comun que esta capa pagina,
 * renderiza y trunca. Esto mantiene la logica de paginacion/truncado
 * independiente de cada herramienta.
 */

import type { Confidence } from '../graph/model.js';

/**
 * Proveniencia de un hecho renderizado. `line`/`column` son opcionales
 * porque algunos hechos (por ejemplo un nodo File) solo tienen archivo,
 * pero `file` nunca se omite (R7: nunca omitir el archivo).
 */
export interface FactProvenance {
  readonly file: string;
  readonly line?: number;
  readonly column?: number;
}

/**
 * Un hecho individual listo para renderizar: el resumen humano, de donde
 * salio y que tan seguro es. `detail` lleva la forma completa para el
 * formato JSON; `markdown.ts` la ignora.
 */
export interface Fact {
  readonly kind: string;
  readonly summary: string;
  readonly provenance: FactProvenance;
  readonly confidence: Confidence;
  readonly detail?: Readonly<Record<string, unknown>>;
}
