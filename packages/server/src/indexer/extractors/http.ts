/**
 * Extractor de llamadas HTTP. Ver docs/PLAN.md, seccion 5.1 y riesgo R3.
 *
 * Recorre un `ts.SourceFile` buscando campos de clase que sean instancias de
 * `HttpClient` (via `inject(HttpClient)`, anotacion de tipo `HttpClient` o
 * parametro de constructor `private http: HttpClient`), y llamadas
 * `this.<campo>.get|post|put|patch|delete(...)` sobre esos campos. Por cada
 * llamada emite un nodo `HttpCall` y una arista `calls_http` desde la clase
 * que la contiene.
 *
 * R3 es explicito: cobertura parcial de llamadas HTTP es aceptable, inventar
 * una URL no lo es. `urlConfidence` distingue:
 *  - 'literal': un string literal o template sin sustituciones.
 *  - 'template': un template literal, una concatenacion con `+`, o una
 *    referencia a `environment.*` o a una constante `export const` del mismo
 *    archivo, siempre que TODAS las partes involucradas sean resolubles de
 *    forma estatica.
 *  - 'unknown': cualquier otra cosa (identificador local no exportado,
 *    llamada a metodo, parametro de funcion, etc.). En ese caso `urlPattern`
 *    es el texto fuente original, nunca un valor inventado.
 *
 * `requestTypeText` (cuerpo de post/put/patch) y `responseTypeText`
 * (primer generico de la llamada) son, igual que en `signals.ts`, texto tal
 * como aparece en el codigo: nunca se evalua ni se interpreta un tipo.
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

/** Mapa de nombre local -> nombre importado, para imports nombrados de `moduleName`. */
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

/** Texto raiz de una cadena de property access, p.ej. `environment` en `environment.api.url`. */
function getRootIdentifierText(typescript: typeof TS, expr: TS.Expression): string | undefined {
  let current: TS.Expression = expr;
  while (typescript.isPropertyAccessExpression(current)) {
    current = current.expression;
  }
  return typescript.isIdentifier(current) ? current.text : undefined;
}

/**
 * Intenta resolver el valor de texto de una expresion por evaluacion
 * estatica limitada (R3): literales, templates y concatenaciones cuyas
 * partes sean a su vez resolubles, `environment.*`, y referencias a
 * constantes `export const` del mismo archivo. Cualquier otra cosa
 * (parametros, variables locales, llamadas a metodos) devuelve `undefined`:
 * nunca se inventa un valor.
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

/** `export const NAME = ...` de nivel superior, resueltas por evaluacion estatica limitada. */
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

/** Campos de `classDeclaration` que son instancias de `HttpClient`. */
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

/** `this.<campo>.<metodo>(...)` donde `<campo>` es un campo HttpClient conocido. */
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
 * Nombre del metodo/constructor/accessor que contiene `node`, buscando hacia
 * arriba sin cruzar el limite de la clase. `undefined` si no hay uno (campo
 * inicializado directamente, caso raro para una llamada HTTP).
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
 * Tipo declarado del parametro `paramName` en la funcion/metodo que contiene
 * `node` (o en uno de sus contenedores, sin cruzar el limite de la clase).
 * Evaluacion estatica limitada: solo lee la anotacion de tipo tal como esta
 * escrita, nunca infiere un tipo.
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
 * Extrae los nodos `HttpCall` y las aristas `calls_http` de `sourceFile`.
 * `relativePath` es la ruta relativa a la raiz del proyecto analizado.
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
