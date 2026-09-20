/**
 * Tope de tamano para respuestas markdown. Ver docs/PLAN.md, seccion 6 y
 * riesgo R6: "Tope de 8 KB por defecto" para que una respuesta grande no
 * reproduzca el problema de contexto que el servidor existe para resolver.
 *
 * Solo aplica a markdown: JSON es la forma completa "solo bajo peticion"
 * (seccion 6) y no se trunca aqui.
 */

export const MAX_MARKDOWN_BYTES = 8 * 1024;

export interface TruncateContext {
  /** Cuantos elementos quedaron en el texto renderizado antes de truncar. */
  readonly shownCount: number;
  /** Total de elementos disponibles (antes de truncar), no solo los de la pagina. */
  readonly totalCount: number;
  /** `next_offset` de la paginacion, si hay mas paginas; null si no. */
  readonly nextOffset: number | null;
}

export interface TruncateResult {
  readonly text: string;
  readonly truncated: boolean;
}

/**
 * Trunca `text` a `maxBytes` (por defecto 8 KB) si hace falta, dejando
 * espacio para un aviso que declara el truncado y explica como pedir el
 * resto.
 */
export function truncateMarkdown(
  text: string,
  context: TruncateContext,
  maxBytes: number = MAX_MARKDOWN_BYTES,
): TruncateResult {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) {
    return { text, truncated: false };
  }

  const notice = buildTruncationNotice(context, maxBytes);
  const budget = Math.max(0, maxBytes - Buffer.byteLength(notice, 'utf8'));
  const body = cutToByteBudget(text, budget);

  return { text: `${body}${notice}`, truncated: true };
}

function buildTruncationNotice(context: TruncateContext, maxBytes: number): string {
  const remaining = Math.max(0, context.totalCount - context.shownCount);
  const howToContinue =
    context.nextOffset !== null
      ? `Pide el resto con \`offset=${context.nextOffset}\` (o reduce \`limit\`).`
      : 'Reduce el alcance de la consulta, o usa `format: "json"` para obtener la forma completa sin resumir.';

  return (
    `\n\n> Respuesta truncada a ${Math.round(maxBytes / 1024)} KB: ` +
    `se muestran ${context.shownCount} de ${context.totalCount} elementos ` +
    `(${remaining} sin mostrar en este bloque). ${howToContinue}`
  );
}

/** Corta `text` a lo sumo `maxBytes` en UTF-8, sin partir un caracter ni una linea a la mitad. */
function cutToByteBudget(text: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return '';
  }
  const buf = Buffer.from(text, 'utf8');
  if (buf.byteLength <= maxBytes) {
    return text;
  }

  let sliceStr = buf.subarray(0, maxBytes).toString('utf8').replace(/�+$/u, '');

  const lastNewline = sliceStr.lastIndexOf('\n');
  if (lastNewline > 0) {
    sliceStr = sliceStr.slice(0, lastNewline);
  }
  return sliceStr;
}
