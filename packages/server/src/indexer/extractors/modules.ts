/**
 * Extractor de `@NgModule`. Ver docs/PLAN.md, secciones 5.1, 5.2 y 9.1.
 *
 * Recorre un `ts.SourceFile` buscando clases decoradas con `@NgModule`
 * (importado de `@angular/core`, con alias respetado) y emite:
 *
 *  - Un nodo `NgModule` con `declarations`/`imports`/`exports`/`providers`
 *    tal como aparecen en el decorador (texto fuente de cada elemento): esa
 *    es la unica fuente de verdad para esos cuatro atributos, ver el
 *    comentario de `NgModuleNode` en graph/model.ts.
 *  - Aristas `imports` (NgModule -> Component|Directive|Pipe|NgModule) por
 *    cada elemento identificador simple del array `imports`.
 *  - Aristas `provides` (NgModule -> Service) por cada elemento del array
 *    `providers`: un identificador simple, o el token de un provider objeto
 *    (`{ provide: TOKEN, ... }`).
 *
 * Elementos que no son un identificador simple (p.ej. `RouterModule.forRoot(routes)`,
 * un provider construido con `useFactory`, un spread) quedan en el atributo
 * de texto del nodo pero no producen arista: resolverlos requeriria
 * evaluacion que esta fuera de alcance (R3, nunca se adivina un destino).
 *
 * La resolucion de un nombre a `NodeId` nunca usa el type checker (solo AST
 * del propio archivo), igual que `routes.ts`/`di.ts`.
 *
 * Puro: no importa `typescript` a nivel de modulo, no toca el filesystem.
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
  /** Nombre real exportado por el modulo origen (antes de un `as alias`). */
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
// Recoleccion: declaraciones locales, imports, decorador @NgModule
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
// Resolucion de nombre -> NodeId (igual heuristica que routes.ts/di.ts)
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
// Atributos del nodo NgModule (texto fuente tal como aparece en el decorador)
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
// Aristas `imports` / `provides`
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
// Punto de entrada
// ---------------------------------------------------------------------------

/**
 * Extrae el nodo `NgModule` y sus aristas `imports`/`provides` de cada clase
 * decorada con `@NgModule` en `sourceFile`. `relativePath` es la ruta
 * relativa a la raiz del proyecto analizado.
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
