/**
 * Source edit behind `angular_add_route` (docs/PLAN.md, section 6, Phase 5):
 * "Inserts into the right routes array (resolved through the graph),
 * respecting lazy/eager according to the dominant pattern."
 *
 * Which array to write into is decided by the caller from the graph — that is
 * what `angular_get_route_tree` is for. What this module decides is *how* the
 * new entry should look, by reading how the neighbouring entries in that same
 * array already look. A lazy route written into an array of eager ones is
 * exactly the hand-fixing R8 warns about.
 *
 * As in add_dependency.ts, the edit is a text splice, so the diff shows the
 * one route that was added rather than a reformatted file.
 */

import type * as TS from 'typescript';

import { detectQuoteStyle } from './style.js';

/** How the routes around the insertion point load their component. */
export type RouteLoadingStyle = 'loadComponent' | 'component';

export interface AddRouteRequest {
  readonly typescript: typeof TS;
  readonly sourceText: string;
  readonly filePath: string;
  /** The `const` that holds the routes array, e.g. `routes` or `ORDERS_ROUTES`. */
  readonly arrayName: string;
  /** The new route's `path`. */
  readonly path: string;
  /** Component class the route targets. */
  readonly component: string;
  /** Module specifier the component lives at, for the lazy import or the static one. */
  readonly componentPath: string;
  /** Force a loading style instead of following the array's dominant one. */
  readonly loading?: RouteLoadingStyle;
}

export interface AddRouteResult {
  readonly after: string;
  readonly loading: RouteLoadingStyle;
  readonly loadingConfidence: 'certain' | 'unknown';
  readonly loadingReason: string;
  /** True when a route with this path is already in the array: the source is returned unchanged. */
  readonly alreadyPresent: boolean;
}

export class AddRouteError extends Error {}

/** Finds the array literal assigned to `arrayName`. */
function findRoutesArray(
  typescript: typeof TS,
  sourceFile: TS.SourceFile,
  arrayName: string,
): TS.ArrayLiteralExpression {
  let found: TS.ArrayLiteralExpression | undefined;

  const visit = (node: TS.Node): void => {
    if (
      typescript.isVariableDeclaration(node) &&
      typescript.isIdentifier(node.name) &&
      node.name.text === arrayName &&
      node.initializer &&
      typescript.isArrayLiteralExpression(node.initializer)
    ) {
      found = node.initializer;
    }
    typescript.forEachChild(node, visit);
  };
  visit(sourceFile);

  if (!found) {
    throw new AddRouteError(
      `No routes array named "${arrayName}" in this file. Call angular_get_route_tree to see which file and ` +
        'array hold the routes you mean.',
    );
  }
  return found;
}

/**
 * Reads the array's dominant loading style. Ties and empty arrays are
 * reported as `unknown` with `loadComponent` as the fallback, rather than
 * presented as if the file had said so (P4).
 */
export function detectRouteLoadingStyle(
  typescript: typeof TS,
  routes: TS.ArrayLiteralExpression,
): { value: RouteLoadingStyle; confidence: 'certain' | 'unknown'; reason: string } {
  let lazy = 0;
  let eager = 0;

  for (const element of routes.elements) {
    if (!typescript.isObjectLiteralExpression(element)) continue;
    for (const property of element.properties) {
      if (!typescript.isPropertyAssignment(property) || !typescript.isIdentifier(property.name)) continue;
      if (property.name.text === 'loadComponent' || property.name.text === 'loadChildren') lazy += 1;
      if (property.name.text === 'component') eager += 1;
    }
  }

  if (lazy === 0 && eager === 0) {
    return {
      value: 'loadComponent',
      confidence: 'unknown',
      reason: 'the array declares no routes with a component yet; defaulted to loadComponent',
    };
  }
  if (lazy === eager) {
    return {
      value: 'loadComponent',
      confidence: 'unknown',
      reason: `the array is evenly split (${lazy} lazy, ${eager} eager); defaulted to loadComponent`,
    };
  }

  return lazy > eager
    ? { value: 'loadComponent', confidence: 'certain', reason: `${lazy} of ${lazy + eager} routes load lazily` }
    : { value: 'component', confidence: 'certain', reason: `${eager} of ${lazy + eager} routes load eagerly` };
}

/** True when the array already declares this path. */
function hasPath(
  typescript: typeof TS,
  routes: TS.ArrayLiteralExpression,
  path: string,
): boolean {
  return routes.elements.some((element) => {
    if (!typescript.isObjectLiteralExpression(element)) return false;
    return element.properties.some(
      (property) =>
        typescript.isPropertyAssignment(property) &&
        typescript.isIdentifier(property.name) &&
        property.name.text === 'path' &&
        typescript.isStringLiteralLike(property.initializer) &&
        property.initializer.text === path,
    );
  });
}

/** The indentation the array's existing elements sit at. */
function elementIndent(sourceText: string, routes: TS.ArrayLiteralExpression, sourceFile: TS.SourceFile): string {
  const first = routes.elements[0];
  if (!first) return '  ';

  const start = first.getStart(sourceFile);
  const lineStart = sourceText.lastIndexOf('\n', start - 1) + 1;
  const indent = sourceText.slice(lineStart, start);

  return /^\s*$/.test(indent) && indent.length > 0 ? indent : '  ';
}

/** Adds a route to the named array, matching how its neighbours are written. */
export function addRoute(request: AddRouteRequest): AddRouteResult {
  const { typescript, sourceText, filePath, arrayName, path, component, componentPath } = request;

  const sourceFile = typescript.createSourceFile(filePath, sourceText, typescript.ScriptTarget.ES2022, true);
  const routes = findRoutesArray(typescript, sourceFile, arrayName);

  if (hasPath(typescript, routes, path)) {
    const detected = detectRouteLoadingStyle(typescript, routes);
    return {
      after: sourceText,
      loading: request.loading ?? detected.value,
      loadingConfidence: detected.confidence,
      loadingReason: detected.reason,
      alreadyPresent: true,
    };
  }

  const detected = detectRouteLoadingStyle(typescript, routes);
  const loading = request.loading ?? detected.value;
  const quote = detectQuoteStyle(sourceText);
  const indent = elementIndent(sourceText, routes, sourceFile);

  const entry =
    loading === 'loadComponent'
      ? [
          `{`,
          `${indent}  path: ${quote}${path}${quote},`,
          `${indent}  loadComponent: () =>`,
          `${indent}    import(${quote}${componentPath}${quote}).then((m) => m.${component}),`,
          `${indent}}`,
        ].join('\n')
      : `{ path: ${quote}${path}${quote}, component: ${component} }`;

  const lastElement = routes.elements[routes.elements.length - 1];

  if (!lastElement) {
    // `[]` — put the single entry on its own line.
    const openBracket = routes.getStart(sourceFile);
    return {
      after: `${sourceText.slice(0, openBracket + 1)}\n${indent}${entry},\n${sourceText.slice(openBracket + 1)}`,
      loading,
      loadingConfidence: detected.confidence,
      loadingReason: detected.reason,
      alreadyPresent: false,
    };
  }

  // Appended last, so an existing catch-all or redirect keeps whatever
  // position the author gave it; Angular matches routes in order, and
  // silently reordering someone's routing table is not a bounded mutation.
  //
  // The insertion point goes *after* any comma the last element already has,
  // and supplies one when it has none. Consuming the existing comma instead
  // would splice the new entry straight onto the previous one and produce a
  // file that does not parse.
  const elementEnd = lastElement.getEnd();
  const trailingComma = /^(\s*),/.exec(sourceText.slice(elementEnd));
  const insertAt = trailingComma ? elementEnd + trailingComma[0].length : elementEnd;
  const prefix = trailingComma ? '' : ',';

  return {
    after: `${sourceText.slice(0, insertAt)}${prefix}\n${indent}${entry},${sourceText.slice(insertAt)}`,
    loading,
    loadingConfidence: detected.confidence,
    loadingReason: detected.reason,
    alreadyPresent: false,
  };
}
