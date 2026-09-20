/**
 * Reactive state extractor. See docs/PLAN.md, sections 5.1 and 9.1.
 *
 * Walks a `ts.SourceFile` and emits one `Signal` node per class field
 * initialized with `signal`, `computed`, `linkedSignal`, `input` (including
 * `input.required`), `model`, `output`, `viewChild`, `viewChildren`,
 * `contentChild`, `contentChildren`, `toSignal`, `resource` or `httpResource`;
 * and one `Observable` node per field whose declared type (an annotation or a
 * `new X()`) is `Observable`, `Subject` or `BehaviorSubject`.
 *
 * It does not follow RxJS flow through `pipe`/`switchMap` (out of scope for v1,
 * see section 13). `typeText` and `initialValueText` are the text exactly as it
 * appears in the code: it is never evaluated nor interpreted.
 *
 * It receives the already-resolved `typescript` module (like `program.ts`): it
 * must always be the analyzed project's `typescript`, not the server's.
 */

import type * as TS from 'typescript';

import { makeNodeId, normalizeRelativePath } from '../../graph/model.js';
import type { ObservableNode, SignalKind, SignalNode } from '../../graph/model.js';

/** Recognized names, imported from any `@angular/*` package. */
const SIGNAL_KIND_BY_ANGULAR_NAME: Readonly<Record<string, SignalKind>> = {
  signal: 'signal',
  computed: 'computed',
  linkedSignal: 'linkedSignal',
  input: 'input',
  model: 'model',
  output: 'output',
  viewChild: 'viewChild',
  viewChildren: 'viewChildren',
  contentChild: 'contentChild',
  contentChildren: 'contentChildren',
  resource: 'resource',
  httpResource: 'httpResource',
  toSignal: 'toSignal',
};

const OBSERVABLE_TYPE_NAMES = new Set(['Observable', 'Subject', 'BehaviorSubject']);

/** Map of local name -> imported name, for `@angular/*` imports only. */
function collectAngularImports(typescript: typeof TS, sourceFile: TS.SourceFile): ReadonlyMap<string, string> {
  const imports = new Map<string, string>();

  for (const statement of sourceFile.statements) {
    if (!typescript.isImportDeclaration(statement)) continue;
    if (!typescript.isStringLiteral(statement.moduleSpecifier)) continue;
    if (!statement.moduleSpecifier.text.startsWith('@angular/')) continue;

    const namedBindings = statement.importClause?.namedBindings;
    if (!namedBindings || !typescript.isNamedImports(namedBindings)) continue;

    for (const element of namedBindings.elements) {
      const importedName = (element.propertyName ?? element.name).text;
      imports.set(element.name.text, importedName);
    }
  }

  return imports;
}

interface ResolvedAngularCall {
  readonly angularName: string;
  readonly required: boolean;
}

/**
 * Resolves the call `foo(...)` or `foo.required(...)` to the name it was
 * imported under from `@angular/*`, when the root identifier comes from there.
 */
function resolveAngularCallee(
  typescript: typeof TS,
  callee: TS.Expression,
  angularImports: ReadonlyMap<string, string>,
): ResolvedAngularCall | undefined {
  if (typescript.isIdentifier(callee)) {
    const angularName = angularImports.get(callee.text);
    return angularName ? { angularName, required: false } : undefined;
  }

  if (typescript.isPropertyAccessExpression(callee) && typescript.isIdentifier(callee.expression)) {
    const angularName = angularImports.get(callee.expression.text);
    if (!angularName) return undefined;
    return { angularName, required: callee.name.text === 'required' };
  }

  return undefined;
}

function getPropertyTypeText(member: TS.PropertyDeclaration, sourceFile: TS.SourceFile): string | undefined {
  return member.type ? member.type.getText(sourceFile) : undefined;
}

function getCallTypeArgText(call: TS.CallExpression, sourceFile: TS.SourceFile): string | undefined {
  const typeArg = call.typeArguments?.[0];
  return typeArg ? typeArg.getText(sourceFile) : undefined;
}

/**
 * Text of the initial value, exactly as it appears in the code. For `toSignal`
 * the first argument is the observable, not a value; there it looks instead for
 * the `initialValue` property of the options object (second argument), when
 * present.
 */
function computeInitialValueText(
  typescript: typeof TS,
  angularName: string,
  call: TS.CallExpression,
  sourceFile: TS.SourceFile,
): string | undefined {
  if (angularName === 'toSignal') {
    const optionsArg = call.arguments[1];
    if (optionsArg && typescript.isObjectLiteralExpression(optionsArg)) {
      for (const prop of optionsArg.properties) {
        if (
          typescript.isPropertyAssignment(prop) &&
          typescript.isIdentifier(prop.name) &&
          prop.name.text === 'initialValue'
        ) {
          return prop.initializer.getText(sourceFile);
        }
      }
    }
    return undefined;
  }

  const firstArg = call.arguments[0];
  return firstArg ? firstArg.getText(sourceFile) : undefined;
}

function tryExtractSignal(
  typescript: typeof TS,
  member: TS.PropertyDeclaration,
  propertyName: string,
  sourceFile: TS.SourceFile,
  path: string,
  className: string,
  angularImports: ReadonlyMap<string, string>,
): SignalNode | undefined {
  if (!member.initializer || !typescript.isCallExpression(member.initializer)) return undefined;

  const call = member.initializer;
  const resolved = resolveAngularCallee(typescript, call.expression, angularImports);
  if (!resolved) return undefined;

  const signalKind = SIGNAL_KIND_BY_ANGULAR_NAME[resolved.angularName];
  if (!signalKind) return undefined;

  return {
    id: makeNodeId(path, `${className}.${propertyName}`),
    kind: 'Signal',
    path,
    name: propertyName,
    ownerRef: makeNodeId(path, className),
    signalKind,
    required: resolved.required,
    typeText: getPropertyTypeText(member, sourceFile) ?? getCallTypeArgText(call, sourceFile),
    initialValueText: computeInitialValueText(typescript, resolved.angularName, call, sourceFile),
  };
}

/** Text of the declared `Observable`/`Subject`/`BehaviorSubject` type, when there is one. */
function getObservableTypeText(
  typescript: typeof TS,
  member: TS.PropertyDeclaration,
  sourceFile: TS.SourceFile,
): string | undefined {
  if (
    member.type &&
    typescript.isTypeReferenceNode(member.type) &&
    typescript.isIdentifier(member.type.typeName) &&
    OBSERVABLE_TYPE_NAMES.has(member.type.typeName.text)
  ) {
    return member.type.getText(sourceFile);
  }

  if (
    member.initializer &&
    typescript.isNewExpression(member.initializer) &&
    typescript.isIdentifier(member.initializer.expression) &&
    OBSERVABLE_TYPE_NAMES.has(member.initializer.expression.text)
  ) {
    const typeName = member.initializer.expression.text;
    const typeArgs = member.initializer.typeArguments;
    if (typeArgs && typeArgs.length > 0) {
      return `${typeName}<${typeArgs.map((typeArg) => typeArg.getText(sourceFile)).join(', ')}>`;
    }
    return typeName;
  }

  return undefined;
}

function tryExtractObservable(
  typescript: typeof TS,
  member: TS.PropertyDeclaration,
  propertyName: string,
  sourceFile: TS.SourceFile,
  path: string,
  className: string,
): ObservableNode | undefined {
  const typeText = getObservableTypeText(typescript, member, sourceFile);
  if (!typeText) return undefined;

  return {
    id: makeNodeId(path, `${className}.${propertyName}`),
    kind: 'Observable',
    path,
    name: propertyName,
    ownerRef: makeNodeId(path, className),
    typeText,
  };
}

/**
 * Extracts the `Signal` and `Observable` nodes declared in the class fields of
 * `sourceFile`. `relativePath` is the path relative to the root of the analyzed
 * project (see `NodeId` in graph/model.ts).
 */
export function extractSignals(
  typescript: typeof TS,
  sourceFile: TS.SourceFile,
  relativePath: string,
): readonly (SignalNode | ObservableNode)[] {
  const path = normalizeRelativePath(relativePath);
  const angularImports = collectAngularImports(typescript, sourceFile);
  const nodes: (SignalNode | ObservableNode)[] = [];

  function visitClassMembers(classDeclaration: TS.ClassDeclaration, className: string): void {
    for (const member of classDeclaration.members) {
      if (!typescript.isPropertyDeclaration(member) || !typescript.isIdentifier(member.name)) continue;

      const propertyName = member.name.text;
      const signalNode = tryExtractSignal(
        typescript,
        member,
        propertyName,
        sourceFile,
        path,
        className,
        angularImports,
      );
      if (signalNode) {
        nodes.push(signalNode);
        continue;
      }

      const observableNode = tryExtractObservable(typescript, member, propertyName, sourceFile, path, className);
      if (observableNode) nodes.push(observableNode);
    }
  }

  function visit(node: TS.Node): void {
    if (typescript.isClassDeclaration(node) && node.name) {
      visitClassMembers(node, node.name.text);
    }
    typescript.forEachChild(node, visit);
  }

  visit(sourceFile);
  return nodes;
}
