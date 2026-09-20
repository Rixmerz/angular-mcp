/**
 * Interceptor extractor. See docs/PLAN.md, section 5.1 — the relationship
 * chain the plan promises runs Component → ... → Service → HTTP →
 * Interceptor, so an interceptor has to exist as a node for that chain to be
 * walkable.
 *
 * Two registration styles are recognized, because Angular has two:
 *
 * - Functional (standalone): `export const authInterceptor: HttpInterceptorFn
 *   = (req, next) => ...`, registered with
 *   `provideHttpClient(withInterceptors([authInterceptor]))`.
 * - Class (NgModule): `class LoggingInterceptor implements HttpInterceptor`,
 *   registered with `{ provide: HTTP_INTERCEPTORS, useClass: ..., multi: true }`.
 *
 * Declaration and registration are extracted separately on purpose. A
 * declaration is a fact about the file being read, so it is `certain`. A
 * registration names a symbol that usually lives in another file, and
 * resolving that name to a path is the same import heuristic the route
 * extractor uses — never checked against disk, so never better than
 * `inferred`, and `unknown` when it cannot be derived at all (P4).
 *
 * Pure: `typescript` is passed in (never imported at module level) and
 * nothing here touches the filesystem.
 */

import type * as TS from 'typescript';

import {
  makeNodeId,
  type Confidence,
  type GraphNode,
  type InterceptorNode,
  type NodeId,
  type Provenance,
  type SymbolKind,
} from '../../graph/model.js';

/**
 * A registration site: somewhere that hands an interceptor to Angular's HTTP
 * stack. It names the interceptor's node, not an edge, because the edge it
 * implies (`intercepted_by`: HttpCall -> Interceptor) spans files and can
 * only be drawn once every file has been read. The orchestrator does that in
 * its cross-file pass.
 */
export interface InterceptorRegistration {
  readonly interceptorId: NodeId;
  readonly confidence: Confidence;
  readonly provenance: Provenance;
}

export interface ExtractInterceptorsResult {
  readonly nodes: GraphNode[];
  readonly registrations: InterceptorRegistration[];
}

/** The type annotation that marks a functional interceptor. */
const FUNCTIONAL_INTERCEPTOR_TYPE = 'HttpInterceptorFn';
/** The interface a class interceptor implements. */
const CLASS_INTERCEPTOR_INTERFACE = 'HttpInterceptor';
/** The DI token class interceptors are registered under. */
const CLASS_INTERCEPTOR_TOKEN = 'HTTP_INTERCEPTORS';

interface ImportBinding {
  readonly moduleSpecifier: string;
  readonly importedName: string;
}

interface Ctx {
  readonly typescript: typeof TS;
  readonly sourceFile: TS.SourceFile;
  readonly filePath: string;
  readonly importDecls: Map<string, ImportBinding>;
  readonly localNames: Set<string>;
  readonly nodes: GraphNode[];
  readonly registrations: InterceptorRegistration[];
}

function provenanceOf(ctx: Ctx, node: TS.Node): Provenance {
  const { line, character } = ctx.sourceFile.getLineAndCharacterOfPosition(node.getStart(ctx.sourceFile));
  return { file: ctx.filePath, line: line + 1, column: character + 1 };
}

/**
 * Resolves a relative specifier to a relative `.ts` path. Identical in spirit
 * to the route extractor's: a pure path join, never checked against disk,
 * which is why anything derived from it is `inferred` at best.
 */
function resolveRelativeSpecifier(currentFilePath: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;

  const segments = currentFilePath.split('/').slice(0, -1);
  for (const part of specifier.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      segments.pop();
      continue;
    }
    segments.push(part);
  }

  const joined = segments.join('/');
  return joined.endsWith('.ts') ? joined : `${joined}.ts`;
}

function collectImports(ctx: Ctx): void {
  const ts = ctx.typescript;

  for (const statement of ctx.sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;

    for (const element of bindings.elements) {
      ctx.importDecls.set(element.name.text, {
        moduleSpecifier: statement.moduleSpecifier.text,
        importedName: (element.propertyName ?? element.name).text,
      });
    }
  }
}

interface ResolvedRef {
  readonly nodeId: NodeId;
  readonly confidence: Confidence;
}

/** Resolves an identifier naming an interceptor to the node it refers to. */
function resolveInterceptorRef(name: string, ctx: Ctx): ResolvedRef {
  if (ctx.localNames.has(name)) {
    return { nodeId: makeNodeId(ctx.filePath, name), confidence: 'certain' };
  }

  const imported = ctx.importDecls.get(name);
  if (imported) {
    const resolvedPath = resolveRelativeSpecifier(ctx.filePath, imported.moduleSpecifier);
    if (resolvedPath) {
      return { nodeId: makeNodeId(resolvedPath, imported.importedName), confidence: 'inferred' };
    }
  }

  // Declared somewhere this extractor cannot see — a barrel, a path alias, a
  // package (R16). The registration is still reported, pointing at a node id
  // built from the current file, and marked unknown rather than dropped.
  return { nodeId: makeNodeId(ctx.filePath, name), confidence: 'unknown' };
}

function addInterceptorNode(ctx: Ctx, name: string, kind: SymbolKind): void {
  const interceptor: InterceptorNode = {
    id: makeNodeId(ctx.filePath, name),
    kind: 'Interceptor',
    name,
    path: ctx.filePath,
    interceptorKind: kind,
  };
  ctx.nodes.push(interceptor);
}

/** `export const x: HttpInterceptorFn = ...` — the functional form. */
function visitVariableStatement(ctx: Ctx, statement: TS.VariableStatement): void {
  const ts = ctx.typescript;

  for (const declaration of statement.declarationList.declarations) {
    if (!ts.isIdentifier(declaration.name)) continue;
    const typeNode = declaration.type;
    if (!typeNode || !ts.isTypeReferenceNode(typeNode)) continue;
    if (!ts.isIdentifier(typeNode.typeName) || typeNode.typeName.text !== FUNCTIONAL_INTERCEPTOR_TYPE) continue;

    addInterceptorNode(ctx, declaration.name.text, 'functional');
  }
}

/** `class X implements HttpInterceptor` — the class form. */
function visitClassDeclaration(ctx: Ctx, declaration: TS.ClassDeclaration): void {
  const ts = ctx.typescript;
  if (!declaration.name) return;

  const implementsInterceptor = (declaration.heritageClauses ?? []).some(
    (clause) =>
      clause.token === ts.SyntaxKind.ImplementsKeyword &&
      clause.types.some(
        (type) => ts.isIdentifier(type.expression) && type.expression.text === CLASS_INTERCEPTOR_INTERFACE,
      ),
  );
  if (!implementsInterceptor) return;

  addInterceptorNode(ctx, declaration.name.text, 'class');
}

function addRegistration(ctx: Ctx, expression: TS.Expression, node: TS.Node): void {
  const ts = ctx.typescript;
  const provenance = provenanceOf(ctx, node);

  if (!ts.isIdentifier(expression)) {
    // An inline arrow, a call, a spread: the interceptor exists but this
    // extractor cannot name it. Saying so is the honest answer (P4).
    return;
  }

  const { nodeId, confidence } = resolveInterceptorRef(expression.text, ctx);
  ctx.registrations.push({ interceptorId: nodeId, confidence, provenance });
}

/** `withInterceptors([a, b])` — functional registration. */
function visitCallExpression(ctx: Ctx, call: TS.CallExpression): void {
  const ts = ctx.typescript;
  if (!ts.isIdentifier(call.expression) || call.expression.text !== 'withInterceptors') return;

  const [first] = call.arguments;
  if (!first || !ts.isArrayLiteralExpression(first)) return;

  for (const element of first.elements) {
    addRegistration(ctx, element, element);
  }
}

/** `{ provide: HTTP_INTERCEPTORS, useClass: X, multi: true }` — class registration. */
function visitObjectLiteral(ctx: Ctx, literal: TS.ObjectLiteralExpression): void {
  const ts = ctx.typescript;

  let providesToken = false;
  let useClass: TS.Expression | undefined;

  for (const property of literal.properties) {
    if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) continue;

    if (property.name.text === 'provide') {
      providesToken =
        ts.isIdentifier(property.initializer) && property.initializer.text === CLASS_INTERCEPTOR_TOKEN;
    } else if (property.name.text === 'useClass' || property.name.text === 'useExisting') {
      useClass = property.initializer;
    }
  }

  if (providesToken && useClass) {
    addRegistration(ctx, useClass, literal);
  }
}

/**
 * Extracts `Interceptor` nodes and every registration site, from a single
 * source file.
 */
export function extractInterceptors(
  typescript: typeof TS,
  sourceFile: TS.SourceFile,
  filePath: string,
): ExtractInterceptorsResult {
  const ctx: Ctx = {
    typescript,
    sourceFile,
    filePath,
    importDecls: new Map(),
    localNames: new Set(),
    nodes: [],
    registrations: [],
  };

  collectImports(ctx);

  // Declarations first, so a file that both declares and registers an
  // interceptor resolves its own name as `certain` rather than `unknown`.
  const ts = typescript;
  const collectDeclarations = (node: TS.Node): void => {
    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) ctx.localNames.add(declaration.name.text);
      }
    } else if (ts.isClassDeclaration(node) && node.name) {
      ctx.localNames.add(node.name.text);
    }
    ts.forEachChild(node, collectDeclarations);
  };
  collectDeclarations(sourceFile);

  const visit = (node: TS.Node): void => {
    if (ts.isVariableStatement(node)) {
      visitVariableStatement(ctx, node);
    } else if (ts.isClassDeclaration(node)) {
      visitClassDeclaration(ctx, node);
    } else if (ts.isCallExpression(node)) {
      visitCallExpression(ctx, node);
    } else if (ts.isObjectLiteralExpression(node)) {
      visitObjectLiteral(ctx, node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return { nodes: ctx.nodes, registrations: ctx.registrations };
}
