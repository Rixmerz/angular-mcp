/**
 * `@NgModule` extractor. See docs/PLAN.md, sections 5.1, 5.2 and 9.1.
 *
 * Walks a `ts.SourceFile` looking for classes decorated with `@NgModule`
 * (imported from `@angular/core`, honoring aliases) and emits:
 *
 *  - An `NgModule` node with `declarations`/`imports`/`exports`/`providers`
 *    exactly as they appear in the decorator (the source text of each element):
 *    that is the only source of truth for those four attributes, see the
 *    comment on `NgModuleNode` in graph/model.ts.
 *  - `imports` edges (NgModule -> Component|Directive|Pipe|NgModule) for every
 *    plain identifier element of the `imports` array.
 *  - `provides` edges (NgModule -> Service) for every element of the
 *    `providers` array: a plain identifier, or the token of an object provider
 *    (`{ provide: TOKEN, ... }`).
 *
 * Elements that are not a plain identifier (e.g. `RouterModule.forRoot(routes)`,
 * a provider built with `useFactory`, a spread) still appear in the node's text
 * attribute but produce no edge: resolving them would require evaluation that
 * is out of scope (R3, a target is never guessed).
 *
 * Resolving a name to a `NodeId` never uses the type checker (only the AST of
 * the file itself), just like `routes.ts`/`di.ts`.
 *
 * Pure: it does not import `typescript` at module level and never touches the
 * filesystem.
 */

import type * as TS from 'typescript';

import { makeNodeId, normalizeRelativePath } from '../../graph/model.js';
import type { Confidence, GraphEdge, ImportsEdge, NgModuleNode, NodeId, Provenance, ProvidesEdge } from '../../graph/model.js';

export interface ExtractModulesResult {
  readonly nodes: readonly NgModuleNode[];
  readonly edges: readonly GraphEdge[];
}

interface ImportBinding {
  readonly moduleSpecifier: string;
  /** The real name exported by the source module (before any `as alias`). */
  readonly importedName: string;
}

interface ModulesCtx {
  readonly typescript: typeof TS;
  readonly sourceFile: TS.SourceFile;
  readonly filePath: string;
  readonly localNames: ReadonlySet<string>;
  readonly importDecls: ReadonlyMap<string, ImportBinding>;
}

// ---------------------------------------------------------------------------
// Collection: local declarations, imports, the @NgModule decorator
// ---------------------------------------------------------------------------

function collectLocalDeclNames(typescript: typeof TS, sourceFile: TS.SourceFile): ReadonlySet<string> {
  const names = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (typescript.isClassDeclaration(statement) && statement.name) names.add(statement.name.text);
    if (typescript.isInterfaceDeclaration(statement)) names.add(statement.name.text);
    if (typescript.isTypeAliasDeclaration(statement)) names.add(statement.name.text);
    if (typescript.isFunctionDeclaration(statement) && statement.name) names.add(statement.name.text);

    if (typescript.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (typescript.isIdentifier(declaration.name)) names.add(declaration.name.text);
      }
    }
  }

  return names;
}

function collectImportDecls(typescript: typeof TS, sourceFile: TS.SourceFile): ReadonlyMap<string, ImportBinding> {
  const imports = new Map<string, ImportBinding>();

  for (const statement of sourceFile.statements) {
    if (!typescript.isImportDeclaration(statement) || !statement.importClause) continue;
    if (!typescript.isStringLiteralLike(statement.moduleSpecifier)) continue;

    const moduleSpecifier = statement.moduleSpecifier.text;
    const clause = statement.importClause;

    if (clause.name) {
      imports.set(clause.name.text, { moduleSpecifier, importedName: 'default' });
    }

    const bindings = clause.namedBindings;
    if (bindings && typescript.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        const importedName = (element.propertyName ?? element.name).text;
        imports.set(element.name.text, { moduleSpecifier, importedName });
      }
    }
  }

  return imports;
}

function collectNamedImportsFromModule(
  typescript: typeof TS,
  sourceFile: TS.SourceFile,
  moduleName: string,
): ReadonlyMap<string, string> {
  const imports = new Map<string, string>();

  for (const statement of sourceFile.statements) {
    if (!typescript.isImportDeclaration(statement)) continue;
    if (!typescript.isStringLiteralLike(statement.moduleSpecifier)) continue;
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

function findDecoratorCall(
  typescript: typeof TS,
  node: TS.Node,
  coreImports: ReadonlyMap<string, string>,
  importedName: string,
): TS.Decorator | undefined {
  if (!typescript.canHaveDecorators(node)) return undefined;
  const decorators = typescript.getDecorators(node);
  if (!decorators) return undefined;

  for (const decorator of decorators) {
    const expr = decorator.expression;
    const callee = typescript.isCallExpression(expr) ? expr.expression : expr;
    if (typescript.isIdentifier(callee) && coreImports.get(callee.text) === importedName) {
      return decorator;
    }
  }

  return undefined;
}

function getDecoratorMetadata(typescript: typeof TS, decorator: TS.Decorator): TS.ObjectLiteralExpression | undefined {
  const expr = decorator.expression;
  if (!typescript.isCallExpression(expr)) return undefined;
  const arg = expr.arguments[0];
  return arg && typescript.isObjectLiteralExpression(arg) ? arg : undefined;
}

function propKeyName(typescript: typeof TS, name: TS.PropertyName): string | undefined {
  return typescript.isIdentifier(name) || typescript.isStringLiteralLike(name) ? name.text : undefined;
}

function collectObjectProps(
  typescript: typeof TS,
  obj: TS.ObjectLiteralExpression | undefined,
): Map<string, TS.Expression> {
  const map = new Map<string, TS.Expression>();
  if (!obj) return map;

  for (const prop of obj.properties) {
    if (!typescript.isPropertyAssignment(prop)) continue;
    const key = propKeyName(typescript, prop.name);
    if (key !== undefined) map.set(key, prop.initializer);
  }

  return map;
}

// ---------------------------------------------------------------------------
// Name -> NodeId resolution (same heuristic as routes.ts/di.ts)
// ---------------------------------------------------------------------------

interface ResolvedTarget {
  readonly nodeId: NodeId;
  readonly confidence: Confidence;
}

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

function resolveTypeName(name: string, ctx: ModulesCtx): ResolvedTarget {
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

  return { nodeId: makeNodeId(ctx.filePath, name), confidence: 'unknown' };
}

function provenanceOf(ctx: ModulesCtx, node: TS.Node): Provenance {
  const { line, character } = ctx.sourceFile.getLineAndCharacterOfPosition(node.getStart(ctx.sourceFile));
  return { file: ctx.filePath, line: line + 1, column: character + 1 };
}

// ---------------------------------------------------------------------------
// NgModule node attributes (source text exactly as it appears in the decorator)
// ---------------------------------------------------------------------------

function readSpecifierArray(
  typescript: typeof TS,
  expr: TS.Expression | undefined,
  sourceFile: TS.SourceFile,
): readonly string[] {
  if (!expr || !typescript.isArrayLiteralExpression(expr)) return [];
  return expr.elements.map((element) => element.getText(sourceFile));
}

// ---------------------------------------------------------------------------
// `imports` / `provides` edges
// ---------------------------------------------------------------------------

function collectImportsEdges(
  typescript: typeof TS,
  importsProp: TS.Expression | undefined,
  classId: NodeId,
  ctx: ModulesCtx,
): ImportsEdge[] {
  if (!importsProp || !typescript.isArrayLiteralExpression(importsProp)) return [];

  const edges: ImportsEdge[] = [];
  for (const element of importsProp.elements) {
    if (!typescript.isIdentifier(element)) continue;
    const resolved = resolveTypeName(element.text, ctx);
    edges.push({
      kind: 'imports',
      from: classId,
      to: resolved.nodeId,
      provenance: provenanceOf(ctx, element),
      confidence: resolved.confidence,
    });
  }
  return edges;
}

function collectProvidesEdges(
  typescript: typeof TS,
  providersProp: TS.Expression | undefined,
  classId: NodeId,
  ctx: ModulesCtx,
): ProvidesEdge[] {
  if (!providersProp || !typescript.isArrayLiteralExpression(providersProp)) return [];

  const edges: ProvidesEdge[] = [];

  function visitArray(arr: TS.ArrayLiteralExpression): void {
    for (const element of arr.elements) {
      if (typescript.isArrayLiteralExpression(element)) {
        visitArray(element);
        continue;
      }

      if (typescript.isIdentifier(element)) {
        const resolved = resolveTypeName(element.text, ctx);
        edges.push({
          kind: 'provides',
          from: classId,
          to: resolved.nodeId,
          provenance: provenanceOf(ctx, element),
          confidence: resolved.confidence,
        });
        continue;
      }

      if (typescript.isObjectLiteralExpression(element)) {
        const objProps = collectObjectProps(typescript, element);
        const provideProp = objProps.get('provide');
        if (provideProp && typescript.isIdentifier(provideProp)) {
          const resolved = resolveTypeName(provideProp.text, ctx);
          edges.push({
            kind: 'provides',
            from: classId,
            to: resolved.nodeId,
            provenance: provenanceOf(ctx, provideProp),
            confidence: resolved.confidence,
          });
        }
      }
    }
  }

  visitArray(providersProp);
  return edges;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Extracts the `NgModule` node and its `imports`/`provides` edges for every
 * class decorated with `@NgModule` in `sourceFile`. `relativePath` is the path
 * relative to the root of the analyzed project.
 */
export function extractModules(
  typescript: typeof TS,
  sourceFile: TS.SourceFile,
  relativePath: string,
): ExtractModulesResult {
  const filePath = normalizeRelativePath(relativePath);
  const coreImports = collectNamedImportsFromModule(typescript, sourceFile, '@angular/core');

  const ctx: ModulesCtx = {
    typescript,
    sourceFile,
    filePath,
    localNames: collectLocalDeclNames(typescript, sourceFile),
    importDecls: collectImportDecls(typescript, sourceFile),
  };

  const nodes: NgModuleNode[] = [];
  const edges: GraphEdge[] = [];

  function processClass(classDeclaration: TS.ClassDeclaration, className: string): void {
    const decorator = findDecoratorCall(typescript, classDeclaration, coreImports, 'NgModule');
    if (!decorator) return;

    const props = collectObjectProps(typescript, getDecoratorMetadata(typescript, decorator));
    const classId = makeNodeId(filePath, className);

    const declarations = readSpecifierArray(typescript, props.get('declarations'), sourceFile);
    const importsArr = readSpecifierArray(typescript, props.get('imports'), sourceFile);
    const exportsArr = readSpecifierArray(typescript, props.get('exports'), sourceFile);
    const providersArr = readSpecifierArray(typescript, props.get('providers'), sourceFile);

    const moduleNode: NgModuleNode = {
      id: classId,
      kind: 'NgModule',
      path: filePath,
      name: className,
      declarations,
      imports: importsArr,
      exports: exportsArr,
      providers: providersArr,
    };
    nodes.push(moduleNode);

    edges.push(...collectImportsEdges(typescript, props.get('imports'), classId, ctx));
    edges.push(...collectProvidesEdges(typescript, props.get('providers'), classId, ctx));
  }

  function visit(node: TS.Node): void {
    if (typescript.isClassDeclaration(node) && node.name) {
      processClass(node, node.name.text);
    }
    typescript.forEachChild(node, visit);
  }

  visit(sourceFile);
  return { nodes, edges };
}
