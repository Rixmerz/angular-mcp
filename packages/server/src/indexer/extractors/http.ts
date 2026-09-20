/**
 * HTTP call extractor. See docs/PLAN.md, section 5.1 and risk R3.
 *
 * Walks a `ts.SourceFile` looking for class fields that are `HttpClient`
 * instances (via `inject(HttpClient)`, an `HttpClient` type annotation, or a
 * constructor parameter `private http: HttpClient`), and for
 * `this.<field>.get|post|put|patch|delete(...)` calls on those fields. For each
 * call it emits an `HttpCall` node and a `calls_http` edge from the enclosing
 * class.
 *
 * R3 is explicit: partial coverage of HTTP calls is acceptable, inventing a URL
 * is not. `urlConfidence` distinguishes:
 *  - 'literal': a string literal, or a template with no substitutions.
 *  - 'template': a template literal, a `+` concatenation, or a reference to
 *    `environment.*` or to an `export const` constant of the same file, as long
 *    as ALL the parts involved can be resolved statically.
 *  - 'unknown': anything else (a local identifier that is not exported, a
 *    method call, a function parameter, etc.). In that case `urlPattern` is the
 *    original source text, never a made-up value.
 *
 * `requestTypeText` (the body of post/put/patch) and `responseTypeText` (the
 * call's first type argument) are, as in `signals.ts`, the text exactly as it
 * appears in the code: a type is never evaluated nor interpreted.
 */

import type * as TS from 'typescript';

import { makeNodeId, normalizeRelativePath } from '../../graph/model.js';
import type { CallsHttpEdge, HttpCallNode, HttpMethod, Provenance, UrlConfidence } from '../../graph/model.js';

const HTTP_METHODS: ReadonlySet<string> = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);
const METHODS_WITH_BODY: ReadonlySet<string> = new Set(['post', 'put', 'patch']);

function getProvenance(sourceFile: TS.SourceFile, node: TS.Node, path: string): Provenance {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { file: path, line: line + 1, column: character + 1 };
}

/** Map of local name -> imported name, for named imports from `moduleName`. */
function collectNamedImports(
  typescript: typeof TS,
  sourceFile: TS.SourceFile,
  moduleName: string,
): ReadonlyMap<string, string> {
  const imports = new Map<string, string>();

  for (const statement of sourceFile.statements) {
    if (!typescript.isImportDeclaration(statement)) continue;
    if (!typescript.isStringLiteral(statement.moduleSpecifier)) continue;
    if (statement.moduleSpecifier.text !== moduleName) continue;

    const namedBindings = statement.importClause?.namedBindings;
    if (!namedBindings || !typescript.isNamedImports(namedBindings)) continue;

    for (const element of namedBindings.elements) {
      const importedName = (element.propertyName ?? element.name).text;
      imports.set(element.name.text, importedName);
    }
  }

  return imports;
}

function findLocalName(imports: ReadonlyMap<string, string>, importedName: string): string | undefined {
  for (const [local, imported] of imports) {
    if (imported === importedName) return local;
  }
  return undefined;
}

/** Root text of a property access chain, e.g. `environment` in `environment.api.url`. */
function getRootIdentifierText(typescript: typeof TS, expr: TS.Expression): string | undefined {
  let current: TS.Expression = expr;
  while (typescript.isPropertyAccessExpression(current)) {
    current = current.expression;
  }
  return typescript.isIdentifier(current) ? current.text : undefined;
}

/**
 * Tries to resolve the text value of an expression through limited static
 * evaluation (R3): literals, templates and concatenations whose parts are
 * themselves resolvable, `environment.*`, and references to `export const`
 * constants of the same file. Anything else (parameters, local variables,
 * method calls) returns `undefined`: a value is never invented.
 */
function tryResolveStaticText(
  typescript: typeof TS,
  expr: TS.Expression,
  sourceFile: TS.SourceFile,
  exportedConstants: ReadonlyMap<string, string>,
): string | undefined {
  if (typescript.isStringLiteralLike(expr)) {
    return expr.text;
  }

  if (typescript.isParenthesizedExpression(expr)) {
    return tryResolveStaticText(typescript, expr.expression, sourceFile, exportedConstants);
  }

  if (typescript.isTemplateExpression(expr)) {
    let result = expr.head.text;
    for (const span of expr.templateSpans) {
      const resolvedSpan = tryResolveStaticText(typescript, span.expression, sourceFile, exportedConstants);
      if (resolvedSpan === undefined) return undefined;
      result += resolvedSpan + span.literal.text;
    }
    return result;
  }

  if (typescript.isBinaryExpression(expr) && expr.operatorToken.kind === typescript.SyntaxKind.PlusToken) {
    const left = tryResolveStaticText(typescript, expr.left, sourceFile, exportedConstants);
    if (left === undefined) return undefined;
    const right = tryResolveStaticText(typescript, expr.right, sourceFile, exportedConstants);
    if (right === undefined) return undefined;
    return left + right;
  }

  if (typescript.isPropertyAccessExpression(expr) && getRootIdentifierText(typescript, expr) === 'environment') {
    return `\${${expr.getText(sourceFile)}}`;
  }

  if (typescript.isIdentifier(expr)) {
    return exportedConstants.get(expr.text);
  }

  return undefined;
}

/** Top-level `export const NAME = ...` declarations, resolved by limited static evaluation. */
function collectExportedConstants(typescript: typeof TS, sourceFile: TS.SourceFile): ReadonlyMap<string, string> {
  const constants = new Map<string, string>();

  for (const statement of sourceFile.statements) {
    if (!typescript.isVariableStatement(statement)) continue;
    if (!(statement.declarationList.flags & typescript.NodeFlags.Const)) continue;

    const isExported =
      typescript.canHaveModifiers(statement) &&
      typescript
        .getModifiers(statement)
        ?.some((modifier) => modifier.kind === typescript.SyntaxKind.ExportKeyword);
    if (!isExported) continue;

    for (const declaration of statement.declarationList.declarations) {
      if (!typescript.isIdentifier(declaration.name) || !declaration.initializer) continue;
      const resolved = tryResolveStaticText(typescript, declaration.initializer, sourceFile, constants);
      if (resolved !== undefined) constants.set(declaration.name.text, resolved);
    }
  }

  return constants;
}

interface ResolvedUrl {
  readonly urlPattern: string;
  readonly urlConfidence: UrlConfidence;
}

function resolveUrlArgument(
  typescript: typeof TS,
  expr: TS.Expression,
  sourceFile: TS.SourceFile,
  exportedConstants: ReadonlyMap<string, string>,
): ResolvedUrl {
  if (typescript.isStringLiteralLike(expr)) {
    return { urlPattern: expr.text, urlConfidence: 'literal' };
  }

  const resolved = tryResolveStaticText(typescript, expr, sourceFile, exportedConstants);
  if (resolved !== undefined) {
    return { urlPattern: resolved, urlConfidence: 'template' };
  }

  return { urlPattern: expr.getText(sourceFile), urlConfidence: 'unknown' };
}

function isHttpClientTypeNode(
  typescript: typeof TS,
  typeNode: TS.TypeNode | undefined,
  httpClientLocalName: string,
): boolean {
  return (
    typeNode !== undefined &&
    typescript.isTypeReferenceNode(typeNode) &&
    typescript.isIdentifier(typeNode.typeName) &&
    typeNode.typeName.text === httpClientLocalName
  );
}

/** Fields of `classDeclaration` that are `HttpClient` instances. */
function collectHttpClientFieldNames(
  typescript: typeof TS,
  classDeclaration: TS.ClassDeclaration,
  httpClientLocalName: string,
  injectLocalName: string | undefined,
): ReadonlySet<string> {
  const fieldNames = new Set<string>();

  for (const member of classDeclaration.members) {
    if (typescript.isPropertyDeclaration(member) && typescript.isIdentifier(member.name)) {
      if (isHttpClientTypeNode(typescript, member.type, httpClientLocalName)) {
        fieldNames.add(member.name.text);
        continue;
      }

      if (
        injectLocalName &&
        member.initializer &&
        typescript.isCallExpression(member.initializer) &&
        typescript.isIdentifier(member.initializer.expression) &&
        member.initializer.expression.text === injectLocalName
      ) {
        const arg = member.initializer.arguments[0];
        if (arg && typescript.isIdentifier(arg) && arg.text === httpClientLocalName) {
          fieldNames.add(member.name.text);
        }
      }
      continue;
    }

    if (typescript.isConstructorDeclaration(member)) {
      for (const param of member.parameters) {
        if (
          typescript.isIdentifier(param.name) &&
          typescript.isParameterPropertyDeclaration(param, member) &&
          isHttpClientTypeNode(typescript, param.type, httpClientLocalName)
        ) {
          fieldNames.add(param.name.text);
        }
      }
    }
  }

  return fieldNames;
}

interface HttpClientCallMatch {
  readonly fieldName: string;
  readonly methodName: string;
}

/** `this.<field>.<method>(...)` where `<field>` is a known HttpClient field. */
function matchHttpClientCall(
  typescript: typeof TS,
  call: TS.CallExpression,
  httpClientFieldNames: ReadonlySet<string>,
): HttpClientCallMatch | undefined {
  const callee = call.expression;
  if (!typescript.isPropertyAccessExpression(callee)) return undefined;

  const target = callee.expression;
  if (!typescript.isPropertyAccessExpression(target)) return undefined;
  if (target.expression.kind !== typescript.SyntaxKind.ThisKeyword) return undefined;
  if (!httpClientFieldNames.has(target.name.text)) return undefined;

  return { fieldName: target.name.text, methodName: callee.name.text };
}

function isFunctionLikeWithParams(typescript: typeof TS, node: TS.Node): node is TS.FunctionLikeDeclarationBase & TS.Node {
  return (
    typescript.isFunctionDeclaration(node) ||
    typescript.isFunctionExpression(node) ||
    typescript.isArrowFunction(node) ||
    typescript.isMethodDeclaration(node) ||
    typescript.isConstructorDeclaration(node) ||
    typescript.isGetAccessorDeclaration(node) ||
    typescript.isSetAccessorDeclaration(node)
  );
}

/**
 * Name of the method/constructor/accessor that contains `node`, searching
 * upwards without crossing the class boundary. `undefined` when there is none
 * (a directly initialized field, a rare case for an HTTP call).
 */
function findEnclosingMemberName(typescript: typeof TS, node: TS.Node): string | undefined {
  let current: TS.Node | undefined = node.parent;

  while (current && !typescript.isClassDeclaration(current) && !typescript.isSourceFile(current)) {
    if (typescript.isConstructorDeclaration(current)) return 'constructor';
    if (
      (typescript.isMethodDeclaration(current) ||
        typescript.isGetAccessorDeclaration(current) ||
        typescript.isSetAccessorDeclaration(current)) &&
      typescript.isIdentifier(current.name)
    ) {
      return current.name.text;
    }
    if (typescript.isPropertyDeclaration(current) && typescript.isIdentifier(current.name)) {
      return current.name.text;
    }
    current = current.parent;
  }

  return undefined;
}

/**
 * Declared type of the parameter `paramName` in the function/method that
 * contains `node` (or in one of its enclosing scopes, without crossing the
 * class boundary). Limited static evaluation: it only reads the type annotation
 * as written, it never infers a type.
 */
function findEnclosingParamTypeText(
  typescript: typeof TS,
  node: TS.Node,
  paramName: string,
  sourceFile: TS.SourceFile,
): string | undefined {
  let current: TS.Node | undefined = node.parent;

  while (current && !typescript.isClassDeclaration(current) && !typescript.isSourceFile(current)) {
    if (isFunctionLikeWithParams(typescript, current)) {
      for (const param of current.parameters) {
        if (typescript.isIdentifier(param.name) && param.name.text === paramName && param.type) {
          return param.type.getText(sourceFile);
        }
      }
    }
    current = current.parent;
  }

  return undefined;
}

function resolveRequestTypeText(
  typescript: typeof TS,
  call: TS.CallExpression,
  methodName: string,
  sourceFile: TS.SourceFile,
): string | undefined {
  if (!METHODS_WITH_BODY.has(methodName)) return undefined;

  const bodyArg = call.arguments[1];
  if (!bodyArg) return undefined;

  if (typescript.isAsExpression(bodyArg) || typescript.isTypeAssertionExpression(bodyArg)) {
    return bodyArg.type.getText(sourceFile);
  }

  if (typescript.isIdentifier(bodyArg)) {
    return findEnclosingParamTypeText(typescript, call, bodyArg.text, sourceFile);
  }

  return undefined;
}

interface HttpCallMatch {
  readonly call: TS.CallExpression;
  readonly methodName: string;
  readonly memberName: string;
}

function collectHttpCallMatches(
  typescript: typeof TS,
  classDeclaration: TS.ClassDeclaration,
  httpClientFieldNames: ReadonlySet<string>,
): readonly HttpCallMatch[] {
  const matches: HttpCallMatch[] = [];

  function visit(node: TS.Node): void {
    if (typescript.isClassDeclaration(node) || typescript.isClassExpression(node)) {
      if (node !== classDeclaration) return;
    }

    if (typescript.isCallExpression(node)) {
      const matched = matchHttpClientCall(typescript, node, httpClientFieldNames);
      if (matched && HTTP_METHODS.has(matched.methodName)) {
        matches.push({
          call: node,
          methodName: matched.methodName,
          memberName: findEnclosingMemberName(typescript, node) ?? 'call',
        });
      }
    }

    typescript.forEachChild(node, visit);
  }

  typescript.forEachChild(classDeclaration, visit);
  return matches;
}

export interface HttpExtractionResult {
  readonly nodes: readonly HttpCallNode[];
  readonly edges: readonly CallsHttpEdge[];
}

/**
 * Extracts the `HttpCall` nodes and the `calls_http` edges of `sourceFile`.
 * `relativePath` is the path relative to the root of the analyzed project.
 */
export function extractHttpCalls(
  typescript: typeof TS,
  sourceFile: TS.SourceFile,
  relativePath: string,
): HttpExtractionResult {
  const path = normalizeRelativePath(relativePath);

  const httpImports = collectNamedImports(typescript, sourceFile, '@angular/common/http');
  const httpClientLocalName = findLocalName(httpImports, 'HttpClient');
  if (!httpClientLocalName) {
    return { nodes: [], edges: [] };
  }

  const coreImports = collectNamedImports(typescript, sourceFile, '@angular/core');
  const injectLocalName = findLocalName(coreImports, 'inject');
  const exportedConstants = collectExportedConstants(typescript, sourceFile);

  const nodes: HttpCallNode[] = [];
  const edges: CallsHttpEdge[] = [];

  function visit(node: TS.Node): void {
    if (typescript.isClassDeclaration(node) && node.name) {
      processClass(node, node.name.text);
    }
    typescript.forEachChild(node, visit);
  }

  function processClass(classDeclaration: TS.ClassDeclaration, className: string): void {
    const httpClientFieldNames = collectHttpClientFieldNames(
      typescript,
      classDeclaration,
      httpClientLocalName!,
      injectLocalName,
    );
    if (httpClientFieldNames.size === 0) return;

    const matches = collectHttpCallMatches(typescript, classDeclaration, httpClientFieldNames);
    if (matches.length === 0) return;

    const occurrencesByKey = new Map<string, number>();
    for (const match of matches) {
      const key = `${match.memberName}.${match.methodName}`;
      occurrencesByKey.set(key, (occurrencesByKey.get(key) ?? 0) + 1);
    }

    const seenByKey = new Map<string, number>();
    const callerRef = makeNodeId(path, className);

    for (const match of matches) {
      const key = `${match.memberName}.${match.methodName}`;
      const total = occurrencesByKey.get(key) ?? 1;
      const seen = (seenByKey.get(key) ?? 0) + 1;
      seenByKey.set(key, seen);
      const name = total > 1 ? `${key}${seen}` : key;

      const urlArg = match.call.arguments[0];
      const { urlPattern, urlConfidence } = urlArg
        ? resolveUrlArgument(typescript, urlArg, sourceFile, exportedConstants)
        : { urlPattern: '', urlConfidence: 'unknown' as UrlConfidence };

      const httpCallNode: HttpCallNode = {
        id: makeNodeId(path, `${className}.${name}`),
        kind: 'HttpCall',
        path,
        name,
        method: match.methodName as HttpMethod,
        urlPattern,
        urlConfidence,
        requestTypeText: resolveRequestTypeText(typescript, match.call, match.methodName, sourceFile),
        responseTypeText: match.call.typeArguments?.[0]?.getText(sourceFile),
        callerRef,
      };
      nodes.push(httpCallNode);

      edges.push({
        kind: 'calls_http',
        from: callerRef,
        to: httpCallNode.id,
        provenance: getProvenance(sourceFile, match.call, path),
        confidence: 'certain',
      });
    }
  }

  visit(sourceFile);
  return { nodes, edges };
}
