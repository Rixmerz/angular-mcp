/**
 * Route extractor. See docs/PLAN.md, sections 5.1, 5.2 and 9.1.
 *
 * Recognizes route arrays declared as a literal (`const routes: Routes =
 * [...]`), passed to `provideRouter(...)`, or to `RouterModule.forRoot(...)` /
 * `RouterModule.forChild(...)`. For each route it emits a `Route` node (path,
 * data, lazy) along with the `routes_to`, `child_of`, `guarded_by` and
 * `resolves_with` edges.
 *
 * Pure: it does not import `typescript` at module level (the analyzed project's
 * module is passed in as a parameter, like in `program.ts`/`resolve.ts`) and it
 * never touches the filesystem. Resolving an import specifier to a NodeId is a
 * file-location heuristic (relative join + `.ts` extension) and is never
 * checked against disk: that is why it is never `certain` — always `inferred`
 * when it could be derived, and `unknown` when it could not.
 */

import type * as TS from 'typescript';

import {
  makeNodeId,
  normalizeRelativePath,
  parseNodeId,
  type Confidence,
  type GraphEdge,
  type GraphNode,
  type GuardNode,
  type NodeId,
  type Provenance,
  type ResolverNode,
  type RouteLazyLoading,
  type RouteNode,
  type SymbolKind,
} from '../../graph/model.js';

export interface ExtractRoutesResult {
  readonly nodes: GraphNode[];
  readonly edges: GraphEdge[];
}

const GUARD_PROPERTY_NAMES = ['canActivate', 'canActivateChild', 'canDeactivate', 'canMatch'] as const;

interface ImportBinding {
  readonly moduleSpecifier: string;
  /** The real name exported by the source module (before any `as alias`). */
  readonly importedName: string;
}

interface ExtractCtx {
  readonly typescript: typeof TS;
  readonly sourceFile: TS.SourceFile;
  readonly filePath: string;
  readonly localDecls: Map<string, SymbolKind>;
  readonly localArrayVars: Map<string, TS.ArrayLiteralExpression>;
  readonly importDecls: Map<string, ImportBinding>;
  readonly nodes: GraphNode[];
  readonly edges: GraphEdge[];
}

/** Extracts the `Route` nodes and their edges from a `ts.SourceFile`. */
export function extractRoutes(typescript: typeof TS, sourceFile: TS.SourceFile): ExtractRoutesResult {
  const ctx: ExtractCtx = {
    typescript,
    sourceFile,
    filePath: normalizeRelativePath(sourceFile.fileName),
    localDecls: new Map(),
    localArrayVars: new Map(),
    importDecls: new Map(),
    nodes: [],
    edges: [],
  };

  collectDeclarations(sourceFile, ctx);

  const roots = new Set<TS.ArrayLiteralExpression>();
  collectRouteArrayRoots(sourceFile, ctx, roots);

  const sortedRoots = Array.from(roots).sort((a, b) => a.pos - b.pos);
  for (const arr of sortedRoots) {
    for (const element of arr.elements) {
      if (typescript.isObjectLiteralExpression(element)) {
        extractRouteObject(element, undefined, ctx);
      }
    }
  }

  return { nodes: ctx.nodes, edges: ctx.edges };
}

// ---------------------------------------------------------------------------
// Route array discovery
// ---------------------------------------------------------------------------

function collectDeclarations(node: TS.Node, ctx: ExtractCtx): void {
  const ts = ctx.typescript;

  if (ts.isImportDeclaration(node) && node.importClause && ts.isStringLiteralLike(node.moduleSpecifier)) {
    const moduleSpecifier = node.moduleSpecifier.text;
    const clause = node.importClause;

    if (clause.name) {
      ctx.importDecls.set(clause.name.text, { moduleSpecifier, importedName: 'default' });
    }

    const bindings = clause.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const spec of bindings.elements) {
        const importedName = (spec.propertyName ?? spec.name).text;
        ctx.importDecls.set(spec.name.text, { moduleSpecifier, importedName });
      }
    }
  }

  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
    const name = node.name.text;
    const init = node.initializer;
    if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
      ctx.localDecls.set(name, 'functional');
    } else if (ts.isArrayLiteralExpression(init)) {
      ctx.localArrayVars.set(name, init);
    }
  }

  if (ts.isFunctionDeclaration(node) && node.name) {
    ctx.localDecls.set(node.name.text, 'functional');
  }

  if (ts.isClassDeclaration(node) && node.name) {
    ctx.localDecls.set(node.name.text, 'class');
  }

  ts.forEachChild(node, (child) => collectDeclarations(child, ctx));
}

function collectRouteArrayRoots(node: TS.Node, ctx: ExtractCtx, roots: Set<TS.ArrayLiteralExpression>): void {
  const ts = ctx.typescript;

  if (ts.isVariableDeclaration(node) && node.initializer && ts.isArrayLiteralExpression(node.initializer)) {
    if (looksLikeRouteArray(node.initializer, ts)) roots.add(node.initializer);
  }

  if (ts.isCallExpression(node)) {
    const isProvideRouter = ts.isIdentifier(node.expression) && node.expression.text === 'provideRouter';
    const isForRootOrForChild =
      ts.isPropertyAccessExpression(node.expression) &&
      (node.expression.name.text === 'forRoot' || node.expression.name.text === 'forChild');

    if (isProvideRouter || isForRootOrForChild) {
      const resolved = resolveRoutesArgument(node.arguments[0], ctx);
      if (resolved) roots.add(resolved);
    }
  }

  ts.forEachChild(node, (child) => collectRouteArrayRoots(child, ctx, roots));
}

function resolveRoutesArgument(
  arg: TS.Expression | undefined,
  ctx: ExtractCtx,
): TS.ArrayLiteralExpression | undefined {
  if (!arg) return undefined;
  const ts = ctx.typescript;
  if (ts.isArrayLiteralExpression(arg)) return arg;
  if (ts.isIdentifier(arg)) return ctx.localArrayVars.get(arg.text);
  return undefined;
}

function looksLikeRouteArray(arr: TS.ArrayLiteralExpression, ts: typeof TS): boolean {
  if (arr.elements.length === 0) return false;
  return arr.elements.every((element) => {
    if (!ts.isObjectLiteralExpression(element)) return false;
    return element.properties.some((prop) => {
      if (!ts.isPropertyAssignment(prop)) return false;
      const key = propertyKeyName(prop.name, ts);
      return key === 'path' || key === 'matcher';
    });
  });
}

// ---------------------------------------------------------------------------
// Extraction of a single route
// ---------------------------------------------------------------------------

function extractRouteObject(obj: TS.ObjectLiteralExpression, parentId: NodeId | undefined, ctx: ExtractCtx): NodeId {
  const ts = ctx.typescript;
  const props = collectPropertyAssignments(obj, ts);

  const pathProp = props.get('path');
  const routePath = pathProp && ts.isStringLiteralLike(pathProp) ? pathProp.text : '';

  const provenance = provenanceOf(ctx, obj);
  const symbol = `Route@${provenance.line}:${provenance.column}`;
  const id = makeNodeId(ctx.filePath, symbol);
  const displayName = routePath.length > 0 ? routePath : '(empty path)';

  let componentRef: NodeId | undefined;
  let lazy: RouteLazyLoading = false;

  const componentProp = props.get('component');
  if (componentProp && ts.isIdentifier(componentProp)) {
    const resolved = resolveSymbolRef(componentProp.text, ctx);
    if (resolved) {
      componentRef = resolved.nodeId;
      ctx.edges.push({
        kind: 'routes_to',
        from: id,
        to: resolved.nodeId,
        provenance: provenanceOf(ctx, componentProp),
        confidence: resolved.confidence,
      });
    }
  }

  const loadComponentProp = props.get('loadComponent');
  if (loadComponentProp) {
    const analyzed = analyzeLazyLoad(loadComponentProp, ctx);
    lazy = { kind: 'loadComponent', specifier: analyzed.specifierText, confidence: analyzed.confidence };
    if (analyzed.resolvedNodeId) {
      componentRef = analyzed.resolvedNodeId;
      ctx.edges.push({
        kind: 'routes_to',
        from: id,
        to: analyzed.resolvedNodeId,
        provenance: provenanceOf(ctx, loadComponentProp),
        confidence: analyzed.confidence,
      });
    }
  }

  const loadChildrenProp = props.get('loadChildren');
  if (loadChildrenProp) {
    const analyzed = analyzeLazyLoad(loadChildrenProp, ctx);
    lazy = { kind: 'loadChildren', specifier: analyzed.specifierText, confidence: analyzed.confidence };
  }

  const guardIds: NodeId[] = [];
  for (const guardProp of GUARD_PROPERTY_NAMES) {
    const value = props.get(guardProp);
    if (!value || !ts.isArrayLiteralExpression(value)) continue;
    for (const element of value.elements) {
      const resolved = resolveGuardOrResolverElement(element, 'Guard', ctx);
      const node: GuardNode = {
        id: resolved.nodeId,
        kind: 'Guard',
        path: parseNodeId(resolved.nodeId).path,
        name: resolved.symbol,
        guardKind: resolved.kind,
      };
      ctx.nodes.push(node);
      guardIds.push(resolved.nodeId);
      ctx.edges.push({
        kind: 'guarded_by',
        from: id,
        to: resolved.nodeId,
        provenance: provenanceOf(ctx, element),
        confidence: resolved.confidence,
      });
    }
  }

  const resolverIds: NodeId[] = [];
  const resolveProp = props.get('resolve');
  if (resolveProp && ts.isObjectLiteralExpression(resolveProp)) {
    for (const prop of resolveProp.properties) {
      if (!ts.isPropertyAssignment(prop)) continue;
      const resolved = resolveGuardOrResolverElement(prop.initializer, 'Resolver', ctx);
      const node: ResolverNode = {
        id: resolved.nodeId,
        kind: 'Resolver',
        path: parseNodeId(resolved.nodeId).path,
        name: resolved.symbol,
        resolverKind: resolved.kind,
      };
      ctx.nodes.push(node);
      resolverIds.push(resolved.nodeId);
      ctx.edges.push({
        kind: 'resolves_with',
        from: id,
        to: resolved.nodeId,
        provenance: provenanceOf(ctx, prop),
        confidence: resolved.confidence,
      });
    }
  }

  const dataProp = props.get('data');
  const data =
    dataProp && ts.isObjectLiteralExpression(dataProp)
      ? (evaluateLiteral(dataProp, ts) as Record<string, unknown>)
      : undefined;

  const childIds: NodeId[] = [];
  const childrenProp = props.get('children');
  if (childrenProp && ts.isArrayLiteralExpression(childrenProp)) {
    for (const element of childrenProp.elements) {
      if (!ts.isObjectLiteralExpression(element)) continue;
      childIds.push(extractRouteObject(element, id, ctx));
    }
  }

  if (parentId) {
    ctx.edges.push({ kind: 'child_of', from: id, to: parentId, provenance, confidence: 'certain' });
  }

  const routeNode: RouteNode = {
    id,
    kind: 'Route',
    path: ctx.filePath,
    name: displayName,
    routePath,
    componentRef,
    lazy,
    guards: guardIds,
    resolvers: resolverIds,
    children: childIds,
    data,
  };
  ctx.nodes.push(routeNode);

  return id;
}

// ---------------------------------------------------------------------------
// Symbol resolution (component / guards / resolvers)
// ---------------------------------------------------------------------------

interface SymbolRef {
  readonly nodeId: NodeId;
  readonly confidence: Confidence;
  readonly kind: SymbolKind;
}

/**
 * Resolves an identifier declared locally in the file, or imported from a
 * static relative specifier, to a NodeId. It never uses the type checker: only
 * the AST of the file itself.
 */
function resolveSymbolRef(name: string, ctx: ExtractCtx): SymbolRef | undefined {
  const localKind = ctx.localDecls.get(name);
  if (localKind) {
    return { nodeId: makeNodeId(ctx.filePath, name), confidence: 'certain', kind: localKind };
  }

  const imported = ctx.importDecls.get(name);
  if (imported) {
    const resolvedPath = resolveRelativeSpecifier(ctx.filePath, imported.moduleSpecifier);
    if (resolvedPath) {
      const kind: SymbolKind = /^[A-Z]/.test(imported.importedName) ? 'class' : 'functional';
      return { nodeId: makeNodeId(resolvedPath, imported.importedName), confidence: 'inferred', kind };
    }
  }

  return undefined;
}

interface GuardResolverRef extends SymbolRef {
  readonly symbol: string;
}

function resolveGuardOrResolverElement(
  expr: TS.Expression,
  label: 'Guard' | 'Resolver',
  ctx: ExtractCtx,
): GuardResolverRef {
  const ts = ctx.typescript;

  if (ts.isIdentifier(expr)) {
    const resolved = resolveSymbolRef(expr.text, ctx);
    if (resolved) {
      return { ...resolved, symbol: parseNodeId(resolved.nodeId).symbol };
    }
    const kind: SymbolKind = /^[A-Z]/.test(expr.text) ? 'class' : 'functional';
    return { nodeId: makeNodeId(ctx.filePath, expr.text), confidence: 'unknown', kind, symbol: expr.text };
  }

  if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) {
    const provenance = provenanceOf(ctx, expr);
    const symbol = `${label}@${provenance.line}:${provenance.column}`;
    return { nodeId: makeNodeId(ctx.filePath, symbol), confidence: 'certain', kind: 'functional', symbol };
  }

  const provenance = provenanceOf(ctx, expr);
  const symbol = `${label}@${provenance.line}:${provenance.column}`;
  return { nodeId: makeNodeId(ctx.filePath, symbol), confidence: 'unknown', kind: 'functional', symbol };
}

/**
 * Resolves a relative specifier (`./foo`, `../bar/baz`) to a relative `.ts`
 * file path, joining it against the current file's directory. It never touches
 * disk (it does not check that the file exists), which is why the result is
 * always treated as `inferred`, never `certain`. Non-relative specifiers
 * (packages, tsconfig path aliases) cannot be resolved here.
 */
function resolveRelativeSpecifier(currentFilePath: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;

  const segments = currentFilePath.split('/').slice(0, -1);
  for (const part of specifier.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      segments.pop();
    } else {
      segments.push(part);
    }
  }

  const joined = segments.join('/');
  return joined.endsWith('.ts') ? joined : `${joined}.ts`;
}

// ---------------------------------------------------------------------------
// loadComponent / loadChildren: dynamic import()
// ---------------------------------------------------------------------------

interface LazyAnalysis {
  readonly specifierText: string;
  readonly confidence: Confidence;
  readonly resolvedNodeId?: NodeId;
}

/**
 * Analyzes the value of `loadComponent`/`loadChildren`: a function that returns
 * (directly or indirectly via `.then`) a dynamic `import()`. It recognizes:
 *   () => import('./x')                        -> exports 'default'
 *   () => import('./x').then(m => m.X)         -> exports 'X'
 *   () => import('./x').then(({ X }) => X)     -> exports 'X'
 *   async () => (await import('./x')).X        -> exports 'X'
 * When the specifier is not a string literal, or the shape is not recognized,
 * it returns confidence 'unknown' with whatever source text is available.
 */
function analyzeLazyLoad(propValue: TS.Expression, ctx: ExtractCtx): LazyAnalysis {
  const ts = ctx.typescript;
  const fallbackText = propValue.getText(ctx.sourceFile);

  const returned = unwrapFunctionBody(propValue, ts);
  if (!returned) return { specifierText: fallbackText, confidence: 'unknown' };

  const stripped = unwrapAwaitAndParens(returned, ts);

  if (ts.isCallExpression(stripped) && isDynamicImportCall(stripped, ts)) {
    return resolveFromImportCall(stripped, undefined, false, ctx, fallbackText);
  }

  if (
    ts.isCallExpression(stripped) &&
    ts.isPropertyAccessExpression(stripped.expression) &&
    stripped.expression.name.text === 'then'
  ) {
    const importCandidate = unwrapAwaitAndParens(stripped.expression.expression, ts);
    if (ts.isCallExpression(importCandidate) && isDynamicImportCall(importCandidate, ts)) {
      const callback = stripped.arguments[0];
      const exportName = callback ? extractThenExportName(callback, ts) : undefined;
      return resolveFromImportCall(importCandidate, exportName, true, ctx, fallbackText);
    }
  }

  if (ts.isPropertyAccessExpression(stripped)) {
    const objectExpr = unwrapAwaitAndParens(stripped.expression, ts);
    if (ts.isCallExpression(objectExpr) && isDynamicImportCall(objectExpr, ts)) {
      return resolveFromImportCall(objectExpr, stripped.name.text, true, ctx, fallbackText);
    }
  }

  return { specifierText: fallbackText, confidence: 'unknown' };
}

function resolveFromImportCall(
  importCall: TS.CallExpression,
  exportName: string | undefined,
  hasThen: boolean,
  ctx: ExtractCtx,
  fallbackText: string,
): LazyAnalysis {
  const ts = ctx.typescript;
  const arg0 = importCall.arguments[0];
  if (!arg0) return { specifierText: fallbackText, confidence: 'unknown' };

  if (!ts.isStringLiteralLike(arg0)) {
    return { specifierText: arg0.getText(ctx.sourceFile), confidence: 'unknown' };
  }

  const specifierText = arg0.text;
  if (hasThen && exportName === undefined) {
    return { specifierText, confidence: 'unknown' };
  }

  const finalExportName = exportName ?? 'default';
  const resolvedPath = resolveRelativeSpecifier(ctx.filePath, specifierText);
  if (!resolvedPath) {
    return { specifierText, confidence: 'unknown' };
  }

  return { specifierText, confidence: 'inferred', resolvedNodeId: makeNodeId(resolvedPath, finalExportName) };
}

function extractThenExportName(callback: TS.Expression, ts: typeof TS): string | undefined {
  if (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) return undefined;

  const param = callback.parameters[0];
  if (!param) return undefined;

  const returned = unwrapFunctionBody(callback, ts);
  if (!returned) return undefined;
  const expr = unwrapAwaitAndParens(returned, ts);

  if (ts.isIdentifier(param.name)) {
    const paramName = param.name.text;
    if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression) && expr.expression.text === paramName) {
      return expr.name.text;
    }
    return undefined;
  }

  if (ts.isObjectBindingPattern(param.name) && ts.isIdentifier(expr)) {
    for (const element of param.name.elements) {
      if (ts.isIdentifier(element.name) && element.name.text === expr.text) {
        const propName = element.propertyName ?? element.name;
        return ts.isIdentifier(propName) ? propName.text : undefined;
      }
    }
  }

  return undefined;
}

function unwrapFunctionBody(fn: TS.Expression, ts: typeof TS): TS.Expression | undefined {
  if (ts.isArrowFunction(fn)) {
    return extractReturnedExpression(fn.body, ts);
  }
  if (ts.isFunctionExpression(fn)) {
    if (!fn.body) return undefined;
    return extractReturnedExpression(fn.body, ts);
  }
  return undefined;
}

function extractReturnedExpression(body: TS.ConciseBody, ts: typeof TS): TS.Expression | undefined {
  if (ts.isBlock(body)) {
    for (const statement of body.statements) {
      if (ts.isReturnStatement(statement) && statement.expression) return statement.expression;
    }
    return undefined;
  }
  return body;
}

/** Dynamic `import(...)`: a CallExpression whose callee is the `import` keyword. */
function isDynamicImportCall(node: TS.CallExpression, ts: typeof TS): boolean {
  return node.expression.kind === ts.SyntaxKind.ImportKeyword;
}

function unwrapAwaitAndParens(expr: TS.Expression, ts: typeof TS): TS.Expression {
  let current = expr;
  while (true) {
    if (ts.isParenthesizedExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isAwaitExpression(current)) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

// ---------------------------------------------------------------------------
// General helpers
// ---------------------------------------------------------------------------

function collectPropertyAssignments(obj: TS.ObjectLiteralExpression, ts: typeof TS): Map<string, TS.Expression> {
  const map = new Map<string, TS.Expression>();
  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const key = propertyKeyName(prop.name, ts);
    if (key === undefined) continue;
    map.set(key, prop.initializer);
  }
  return map;
}

function propertyKeyName(name: TS.PropertyName, ts: typeof TS): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  return undefined;
}

function evaluateLiteral(expr: TS.Expression, ts: typeof TS): unknown {
  if (ts.isStringLiteralLike(expr)) return expr.text;
  if (ts.isNumericLiteral(expr)) return Number(expr.text);
  if (expr.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (expr.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (expr.kind === ts.SyntaxKind.NullKeyword) return null;

  if (ts.isArrayLiteralExpression(expr)) {
    const values: unknown[] = [];
    for (const element of expr.elements) {
      const value = evaluateLiteral(element, ts);
      if (value !== undefined) values.push(value);
    }
    return values;
  }

  if (ts.isObjectLiteralExpression(expr)) {
    const result: Record<string, unknown> = {};
    for (const prop of expr.properties) {
      if (!ts.isPropertyAssignment(prop)) continue;
      const key = propertyKeyName(prop.name, ts);
      if (key === undefined) continue;
      const value = evaluateLiteral(prop.initializer, ts);
      if (value !== undefined) result[key] = value;
    }
    return result;
  }

  return undefined;
}

function provenanceOf(ctx: ExtractCtx, node: TS.Node): Provenance {
  const { line, character } = ctx.sourceFile.getLineAndCharacterOfPosition(node.getStart(ctx.sourceFile));
  return { file: ctx.filePath, line: line + 1, column: character + 1 };
}
