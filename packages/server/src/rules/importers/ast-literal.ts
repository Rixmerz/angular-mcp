/**
 * Converts a small, safe subset of a TypeScript/JavaScript AST into plain
 * JS values, WITHOUT ever executing the source file. Shared by
 * importers/sheriff.ts and importers/nx.ts: both need to read a literal
 * object out of a config file (`sheriff.config.ts`, an eslint config) that
 * may contain arbitrary code, and running that code would be a real risk
 * (the file belongs to the analyzed project, not to the MCP — see R11 in
 * docs/PLAN.md). Anything that is not a literal (a function call, a spread, a
 * computed key, a template literal with substitutions) makes the containing
 * value unresolved (`undefined`); callers turn that into a warning, never a
 * guess (P4).
 */

import type * as TS from 'typescript';

export type Literal =
  | string
  | number
  | boolean
  | null
  | readonly Literal[]
  | { readonly [key: string]: Literal }
  | { readonly __ident: string };

export function isLiteralObject(value: Literal | undefined): value is { readonly [key: string]: Literal } {
  return value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value) && !('__ident' in value);
}

export function isLiteralArray(value: Literal | undefined): value is readonly Literal[] {
  return Array.isArray(value);
}

export function isLiteralString(value: Literal | undefined): value is string {
  return typeof value === 'string';
}

export function isLiteralIdentifier(value: Literal | undefined): value is { readonly __ident: string } {
  return value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value) && '__ident' in value;
}

/**
 * Reads `key` off a literal object. A plain helper instead of direct indexed
 * access after `isLiteralObject`: TS considers `{ __ident: string }`
 * structurally assignable to the object variant of `Literal` too (every one
 * of its properties fits `{ [key: string]: Literal }`), so a type guard alone
 * does not narrow away the identifier arm. The cast is contained here.
 */
export function getLiteralProperty(value: Literal | undefined, key: string): Literal | undefined {
  if (!isLiteralObject(value)) return undefined;
  return (value as Record<string, Literal>)[key];
}

function propertyKeyName(typescript: typeof TS, name: TS.PropertyName): string | undefined {
  if (typescript.isIdentifier(name) || typescript.isStringLiteralLike(name) || typescript.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
}

/** Converts a TS expression node into a plain literal. Returns `undefined` for anything not statically resolvable. */
export function nodeToLiteral(typescript: typeof TS, node: TS.Node): Literal | undefined {
  if (typescript.isStringLiteralLike(node)) return node.text;
  if (typescript.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === typescript.SyntaxKind.TrueKeyword) return true;
  if (node.kind === typescript.SyntaxKind.FalseKeyword) return false;
  if (node.kind === typescript.SyntaxKind.NullKeyword) return null;
  if (typescript.isIdentifier(node)) return { __ident: node.text };

  if (typescript.isParenthesizedExpression(node)) return nodeToLiteral(typescript, node.expression);
  if (typescript.isAsExpression(node)) return nodeToLiteral(typescript, node.expression);

  if (typescript.isArrayLiteralExpression(node)) {
    const items: Literal[] = [];
    for (const element of node.elements) {
      const value = nodeToLiteral(typescript, element);
      if (value === undefined) return undefined;
      items.push(value);
    }
    return items;
  }

  if (typescript.isObjectLiteralExpression(node)) {
    const result: Record<string, Literal> = {};
    for (const prop of node.properties) {
      if (!typescript.isPropertyAssignment(prop)) return undefined;
      const key = propertyKeyName(typescript, prop.name);
      if (key === undefined) return undefined;
      const value = nodeToLiteral(typescript, prop.initializer);
      if (value === undefined) return undefined;
      result[key] = value;
    }
    return result;
  }

  return undefined;
}

/** Finds the first object literal in `sourceFile` that directly declares any property named in `keys`. */
export function findObjectLiteralContainingAnyKey(
  typescript: typeof TS,
  sourceFile: TS.SourceFile,
  keys: readonly string[],
): TS.ObjectLiteralExpression | undefined {
  let found: TS.ObjectLiteralExpression | undefined;

  function visit(node: TS.Node): void {
    if (found) return;
    if (typescript.isObjectLiteralExpression(node)) {
      const hasKey = node.properties.some(
        (prop) => typescript.isPropertyAssignment(prop) && keys.includes(propertyKeyName(typescript, prop.name) ?? ''),
      );
      if (hasKey) {
        found = node;
        return;
      }
    }
    typescript.forEachChild(node, visit);
  }

  visit(sourceFile);
  return found;
}
