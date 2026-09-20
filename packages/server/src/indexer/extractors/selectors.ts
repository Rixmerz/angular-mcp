/**
 * Selector scope resolution. See docs/PLAN.md, sections 4.3 and 5.2, and risk
 * R4 (hybrid NgModule + standalone projects producing incorrect selector
 * resolution in templates).
 *
 * Table 4.3 states the heuristic explicitly: resolving which component a
 * template tag belongs to is *ours*, not the compiler's, based on:
 *
 *  - the rendering component's own `imports` array, when it is `standalone`;
 *  - the `declarations` of the NgModule that declares it, otherwise.
 *
 * Both paths resolve plain-identifier specifiers to a `NodeId` with the same
 * local-name/import heuristic used by `modules.ts`/`di.ts`/`routes.ts`
 * (certain for a local class, inferred through a relative import, unknown
 * otherwise) and then intersect the result against the set of already-known
 * `Component`/`Directive`/`Pipe` nodes to read their selector text.
 *
 * This module never touches the filesystem and never uses the type checker:
 * only the AST of the component's own file (or its declaring NgModule's), like
 * every other extractor.
 */

import type * as TS from 'typescript';

import { makeNodeId } from '../../graph/model.js';
import type { ComponentNode, Confidence, DirectiveNode, NgModuleNode, NodeId, PipeNode } from '../../graph/model.js';

/** A node that can be referenced from a template by a CSS-like selector or, for pipes, a name. */
export type SelectorTargetNode = ComponentNode | DirectiveNode | PipeNode;

export interface ScopeEntry {
  /** One already-split, bracket-stripped selector token (e.g. `app-child`, `appHighlight`) or a pipe name. */
  readonly selector: string;
  readonly targetRef: NodeId;
  readonly targetKind: SelectorTargetNode['kind'];
  readonly confidence: Confidence;
}

export type ScopeResolution = 'standalone' | 'ngmodule' | 'unknown';

export interface ComponentScope {
  readonly ownerRef: NodeId;
  readonly resolvedBy: ScopeResolution;
  /** The NgModule this scope was resolved through, only when `resolvedBy === 'ngmodule'`. */
  readonly viaModuleRef?: NodeId;
  readonly entries: readonly ScopeEntry[];
}

// ---------------------------------------------------------------------------
// Local declarations / imports of a single file (same heuristic as modules.ts)
// ---------------------------------------------------------------------------

interface ImportBinding {
  readonly moduleSpecifier: string;
  readonly importedName: string;
}

interface FileScopeCtx {
  readonly filePath: string;
  readonly localNames: ReadonlySet<string>;
  readonly importDecls: ReadonlyMap<string, ImportBinding>;
}

interface ResolvedTarget {
  readonly nodeId: NodeId;
  readonly confidence: Confidence;
}

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

function makeFileScopeCtx(typescript: typeof TS, sourceFile: TS.SourceFile, filePath: string): FileScopeCtx {
  return {
    filePath,
    localNames: collectLocalDeclNames(typescript, sourceFile),
    importDecls: collectImportDecls(typescript, sourceFile),
  };
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

function resolveTypeName(name: string, ctx: FileScopeCtx): ResolvedTarget {
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

// ---------------------------------------------------------------------------
// Reading a standalone component's own `imports: [...]` array
// ---------------------------------------------------------------------------

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

function findImportsPropExpression(
  typescript: typeof TS,
  sourceFile: TS.SourceFile,
  className: string,
): TS.Expression | undefined {
  const coreImports = collectNamedImportsFromModule(typescript, sourceFile, '@angular/core');
  let found: TS.Expression | undefined;

  function visit(node: TS.Node): void {
    if (found) return;
    if (typescript.isClassDeclaration(node) && node.name?.text === className) {
      const decorator = findDecoratorCall(typescript, node, coreImports, 'Component');
      const metadata = decorator && getDecoratorMetadata(typescript, decorator);
      const importsProp = metadata?.properties.find(
        (prop): prop is TS.PropertyAssignment =>
          typescript.isPropertyAssignment(prop) &&
          (typescript.isIdentifier(prop.name) || typescript.isStringLiteralLike(prop.name)) &&
          prop.name.text === 'imports',
      );
      found = importsProp?.initializer;
      return;
    }
    typescript.forEachChild(node, visit);
  }

  visit(sourceFile);
  return found;
}

/**
 * Reads the raw `imports: [...]` array of a standalone component's own
 * `@Component` decorator and resolves every plain-identifier element to a
 * `NodeId`. Elements that are not a plain identifier (a call, a spread, a
 * namespaced member) are skipped: resolving them is out of scope, same as the
 * `imports` array of an `@NgModule` in `modules.ts`.
 */
export function extractStandaloneComponentImports(
  typescript: typeof TS,
  sourceFile: TS.SourceFile,
  filePath: string,
  className: string,
): readonly ResolvedTarget[] {
  const importsExpr = findImportsPropExpression(typescript, sourceFile, className);
  if (!importsExpr || !typescript.isArrayLiteralExpression(importsExpr)) return [];

  const ctx = makeFileScopeCtx(typescript, sourceFile, filePath);
  const resolved: ResolvedTarget[] = [];

  for (const element of importsExpr.elements) {
    if (typescript.isIdentifier(element)) {
      resolved.push(resolveTypeName(element.text, ctx));
    }
  }

  return resolved;
}

/**
 * Resolves every plain-identifier element of an `@NgModule`'s `declarations`
 * array (as already extracted onto `NgModuleNode.declarations`, verbatim
 * source text) to a `NodeId`, against the module's own file.
 */
export function resolveNgModuleDeclarations(
  typescript: typeof TS,
  moduleSourceFile: TS.SourceFile,
  moduleFilePath: string,
  declarations: readonly string[],
): readonly ResolvedTarget[] {
  const ctx = makeFileScopeCtx(typescript, moduleSourceFile, moduleFilePath);
  const identifierPattern = /^[A-Za-z_$][\w$]*$/;

  return declarations.filter((text) => identifierPattern.test(text)).map((text) => resolveTypeName(text, ctx));
}

// ---------------------------------------------------------------------------
// Selector text -> match tokens (tag name, each `[attr]`, pipe name)
// ---------------------------------------------------------------------------

function parseSelectorTokens(rawSelector: string): readonly string[] {
  const tokens: string[] = [];

  for (const part of rawSelector.split(',')) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;

    const attributeMatches = trimmed.match(/\[([^\]=]+)(?:=[^\]]*)?\]/g) ?? [];
    for (const attributeMatch of attributeMatches) {
      const inner = attributeMatch.slice(1, -1).split('=')[0]?.trim();
      if (inner) tokens.push(inner);
    }

    const tagMatch = /^[A-Za-z][\w-]*/.exec(trimmed);
    if (tagMatch) tokens.push(tagMatch[0]);
  }

  return tokens;
}

function entriesForTarget(node: SelectorTargetNode, targetRef: NodeId, confidence: Confidence): readonly ScopeEntry[] {
  if (node.kind === 'Pipe') {
    return [{ selector: node.name, targetRef, targetKind: 'Pipe', confidence }];
  }

  if (!node.selector) return [];
  return parseSelectorTokens(node.selector).map((selector) => ({
    selector,
    targetRef,
    targetKind: node.kind,
    confidence,
  }));
}

function buildEntries(
  resolvedRefs: readonly ResolvedTarget[],
  knownNodes: readonly SelectorTargetNode[],
): readonly ScopeEntry[] {
  const byId = new Map(knownNodes.map((node) => [node.id, node] as const));
  const entries: ScopeEntry[] = [];

  for (const ref of resolvedRefs) {
    const target = byId.get(ref.nodeId);
    if (!target) continue;
    entries.push(...entriesForTarget(target, ref.nodeId, ref.confidence));
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface ResolveComponentScopeParams {
  readonly typescript: typeof TS;
  readonly component: ComponentNode;
  /** The component's own source file. Required to resolve a `standalone` component's scope. */
  readonly componentSourceFile?: TS.SourceFile;
  /** Every `NgModule` node in the project, searched for one that declares this component. */
  readonly ngModules?: readonly NgModuleNode[];
  /** Source file of each candidate NgModule above, keyed by `NgModuleNode.path`. */
  readonly ngModuleSourceFiles?: ReadonlyMap<string, TS.SourceFile>;
  /** Every `Component`/`Directive`/`Pipe` node known in the project. */
  readonly knownNodes: readonly SelectorTargetNode[];
}

/**
 * Resolves the set of selectors (and pipe names) usable from `component`'s own
 * template: its own `imports` when `standalone`, or the `declarations` of the
 * NgModule that declares it otherwise (R4). Returns `resolvedBy: 'unknown'`
 * with no entries when neither path can be resolved (a standalone component
 * with no source file given, or a declared one whose module was not found) —
 * never a guess.
 */
export function resolveComponentScope(params: ResolveComponentScopeParams): ComponentScope {
  const { typescript, component, componentSourceFile, ngModules, ngModuleSourceFiles, knownNodes } = params;

  if (component.standalone) {
    if (!componentSourceFile) {
      return { ownerRef: component.id, resolvedBy: 'unknown', entries: [] };
    }

    const resolvedRefs = extractStandaloneComponentImports(
      typescript,
      componentSourceFile,
      component.path,
      component.name,
    );
    return { ownerRef: component.id, resolvedBy: 'standalone', entries: buildEntries(resolvedRefs, knownNodes) };
  }

  const owningModule = ngModules?.find((module) => module.declarations.includes(component.name));
  const moduleSourceFile = owningModule && ngModuleSourceFiles?.get(owningModule.path);

  if (!owningModule || !moduleSourceFile) {
    return { ownerRef: component.id, resolvedBy: 'unknown', entries: [] };
  }

  const resolvedRefs = resolveNgModuleDeclarations(
    typescript,
    moduleSourceFile,
    owningModule.path,
    owningModule.declarations,
  );

  return {
    ownerRef: component.id,
    resolvedBy: 'ngmodule',
    viaModuleRef: owningModule.id,
    entries: buildEntries(resolvedRefs, knownNodes),
  };
}

/** Every scope entry whose selector token matches `name` exactly. */
export function matchSelector(scope: ComponentScope, name: string): readonly ScopeEntry[] {
  return scope.entries.filter((entry) => entry.selector === name);
}
