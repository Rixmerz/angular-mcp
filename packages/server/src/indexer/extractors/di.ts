/**
 * Extractor de inyeccion de dependencias. Ver docs/PLAN.md, secciones 5.2 y 9.1.
 *
 * Recorre un `ts.SourceFile` buscando, en cada clase, dos mecanismos de
 * inyeccion (ver tabla 5.2, arista `injects`):
 *
 *  1. Por constructor: cada parametro del constructor cuyo tipo (o el token
 *     de un `@Inject(TOKEN)`) resuelve a un simbolo.
 *  2. Por `inject()`: cada campo de clase inicializado con `inject(TOKEN)`.
 *
 * `@Optional()` (constructor) e `inject(TOKEN, { optional: true })` marcan
 * `optional: true` en la arista. `@Inject(TOKEN)` reemplaza el tipo
 * declarado del parametro por el token explicito, que es lo que realmente se
 * inyecta en tiempo de ejecucion.
 *
 * La resolucion de un nombre a `NodeId` nunca usa el type checker (solo AST
 * del propio archivo), igual que `routes.ts`: una clase/interfaz/tipo/const
 * declarada en el mismo archivo es `certain`; un import relativo es
 * `inferred` (heuristica de posicion de archivo, nunca se verifica contra
 * disco); cualquier otra cosa (import de paquete, expresion compleja) cae a
 * `unknown` con un NodeId sintetico en el archivo actual, nunca se omite la
 * arista ni se inventa una ruta (R3, R7).
 *
 * Puro: no importa `typescript` a nivel de modulo, no toca el filesystem.
 */

import type * as TS from 'typescript';

import { makeNodeId, normalizeRelativePath } from '../../graph/model.js';
import type { Confidence, InjectsEdge, NodeId, Provenance } from '../../graph/model.js';

interface ImportBinding {
  readonly moduleSpecifier: string;
  /** Nombre real exportado por el modulo origen (antes de un `as alias`). */
  readonly importedName: string;
}

interface DiCtx {
  readonly typescript: typeof TS;
  readonly sourceFile: TS.SourceFile;
  readonly filePath: string;
  readonly localNames: ReadonlySet<string>;
  readonly importDecls: ReadonlyMap<string, ImportBinding>;
  readonly coreImports: ReadonlyMap<string, string>;
  readonly injectLocalName: string | undefined;
}

// ---------------------------------------------------------------------------
// Recoleccion: declaraciones locales, imports, decoradores
// ---------------------------------------------------------------------------

/** Nombres declarados a nivel de modulo (clase, interfaz, tipo, funcion, const/let/var). */
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

/** Mapa de nombre local -> nombre importado, para imports nombrados de `moduleName`. */
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

function findLocalName(imports: ReadonlyMap<string, string>, importedName: string): string | undefined {
  for (const [local, imported] of imports) {
    if (imported === importedName) return local;
  }
  return undefined;
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

function hasDecorator(
  typescript: typeof TS,
  node: TS.Node,
  coreImports: ReadonlyMap<string, string>,
  importedName: string,
): boolean {
  return findDecoratorCall(typescript, node, coreImports, importedName) !== undefined;
}

// ---------------------------------------------------------------------------
// Resolucion de nombre -> NodeId
// ---------------------------------------------------------------------------

interface ResolvedTarget {
  readonly nodeId: NodeId;
  readonly confidence: Confidence;
}

/**
 * Resuelve un especificador relativo (`./foo`, `../bar/baz`) a una ruta
 * relativa de archivo `.ts`, uniendola contra el directorio del archivo
 * actual. Nunca toca disco (no verifica que el archivo exista).
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

function resolveTypeName(name: string, ctx: DiCtx): ResolvedTarget {
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

/** Resuelve el token inyectado: un identificador se trata como nombre de simbolo; cualquier otra
 * expresion (literal, property access, etc.) cae a `unknown` con su texto fuente como simbolo. */
function resolveExpressionTarget(typescript: typeof TS, expr: TS.Expression, ctx: DiCtx): ResolvedTarget {
  if (typescript.isIdentifier(expr)) return resolveTypeName(expr.text, ctx);
  const text = expr.getText(ctx.sourceFile);
  return { nodeId: makeNodeId(ctx.filePath, text), confidence: 'unknown' };
}

function provenanceOf(ctx: DiCtx, node: TS.Node): Provenance {
  const { line, character } = ctx.sourceFile.getLineAndCharacterOfPosition(node.getStart(ctx.sourceFile));
  return { file: ctx.filePath, line: line + 1, column: character + 1 };
}

// ---------------------------------------------------------------------------
// Inyeccion por constructor
// ---------------------------------------------------------------------------

function extractConstructorInjections(
  typescript: typeof TS,
  classDeclaration: TS.ClassDeclaration,
  classId: NodeId,
  ctx: DiCtx,
): InjectsEdge[] {
  const edges: InjectsEdge[] = [];

  const constructorMember = classDeclaration.members.find((member): member is TS.ConstructorDeclaration =>
    typescript.isConstructorDeclaration(member),
  );
  if (!constructorMember) return edges;

  for (const param of constructorMember.parameters) {
    if (!typescript.isIdentifier(param.name)) continue;

    const optional = hasDecorator(typescript, param, ctx.coreImports, 'Optional');
    const injectDecorator = findDecoratorCall(typescript, param, ctx.coreImports, 'Inject');

    let resolved: ResolvedTarget | undefined;

    if (injectDecorator && typescript.isCallExpression(injectDecorator.expression)) {
      const tokenArg = injectDecorator.expression.arguments[0];
      if (tokenArg) resolved = resolveExpressionTarget(typescript, tokenArg, ctx);
    } else if (param.type && typescript.isTypeReferenceNode(param.type) && typescript.isIdentifier(param.type.typeName)) {
      resolved = resolveTypeName(param.type.typeName.text, ctx);
    }

    if (!resolved) continue;

    edges.push({
      kind: 'injects',
      from: classId,
      to: resolved.nodeId,
      provenance: provenanceOf(ctx, param),
      confidence: resolved.confidence,
      via: 'constructor',
      optional,
    });
  }

  return edges;
}

// ---------------------------------------------------------------------------
// Inyeccion por inject()
// ---------------------------------------------------------------------------

function readInjectOptionsOptional(typescript: typeof TS, optionsArg: TS.Expression | undefined): boolean {
  if (!optionsArg || !typescript.isObjectLiteralExpression(optionsArg)) return false;

  for (const prop of optionsArg.properties) {
    if (
      typescript.isPropertyAssignment(prop) &&
      typescript.isIdentifier(prop.name) &&
      prop.name.text === 'optional'
    ) {
      return prop.initializer.kind === typescript.SyntaxKind.TrueKeyword;
    }
  }

  return false;
}

function extractInjectCalls(
  typescript: typeof TS,
  classDeclaration: TS.ClassDeclaration,
  classId: NodeId,
  ctx: DiCtx,
): InjectsEdge[] {
  const edges: InjectsEdge[] = [];
  if (!ctx.injectLocalName) return edges;

  for (const member of classDeclaration.members) {
    if (!typescript.isPropertyDeclaration(member)) continue;
    if (!member.initializer || !typescript.isCallExpression(member.initializer)) continue;

    const call = member.initializer;
    if (!typescript.isIdentifier(call.expression) || call.expression.text !== ctx.injectLocalName) continue;

    const tokenArg = call.arguments[0];
    if (!tokenArg) continue;

    const resolved = resolveExpressionTarget(typescript, tokenArg, ctx);
    const optional = readInjectOptionsOptional(typescript, call.arguments[1]);

    edges.push({
      kind: 'injects',
      from: classId,
      to: resolved.nodeId,
      provenance: provenanceOf(ctx, call),
      confidence: resolved.confidence,
      via: 'inject',
      optional,
    });
  }

  return edges;
}

// ---------------------------------------------------------------------------
// Punto de entrada
// ---------------------------------------------------------------------------

/**
 * Extrae las aristas `injects` de cada clase declarada en `sourceFile`,
 * combinando inyeccion por constructor e inyeccion por `inject()`.
 * `relativePath` es la ruta relativa a la raiz del proyecto analizado.
 */
export function extractInjections(
  typescript: typeof TS,
  sourceFile: TS.SourceFile,
  relativePath: string,
): readonly InjectsEdge[] {
  const filePath = normalizeRelativePath(relativePath);
  const coreImports = collectNamedImportsFromModule(typescript, sourceFile, '@angular/core');

  const ctx: DiCtx = {
    typescript,
    sourceFile,
    filePath,
    localNames: collectLocalDeclNames(typescript, sourceFile),
    importDecls: collectImportDecls(typescript, sourceFile),
    coreImports,
    injectLocalName: findLocalName(coreImports, 'inject'),
  };

  const edges: InjectsEdge[] = [];

  function visit(node: TS.Node): void {
    if (typescript.isClassDeclaration(node) && node.name) {
      const classId = makeNodeId(filePath, node.name.text);
      edges.push(...extractConstructorInjections(typescript, node, classId, ctx));
      edges.push(...extractInjectCalls(typescript, node, classId, ctx));
    }
    typescript.forEachChild(node, visit);
  }

  visit(sourceFile);
  return edges;
}
