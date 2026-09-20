/**
 * Class decorator extractor. See docs/PLAN.md, sections 5.1 and 9.1.
 *
 * Walks a `ts.SourceFile` looking for classes decorated with `@Component`,
 * `@Directive`, `@Pipe` or `@Injectable` (all imported from `@angular/core`,
 * honoring aliases) and emits one node per class, with the attributes listed in
 * table 5.1. A class with none of these decorators produces no node.
 *
 * `inputs`/`outputs` cover both declaration styles: the decorator
 * (`@Input()`/`@Output()`) and the signal-based functions (`input()`,
 * `input.required()`, `model()`, `output()`), reusing `extractSignals` for the
 * latter instead of reimplementing its detection.
 *
 * Pure: it does not import `typescript` at module level (the analyzed project's
 * module is passed in as a parameter, like in every other extractor) and it
 * never touches the filesystem. Resolving `templateUrl`/`styleUrl(s)` to a path
 * is a file-location heuristic and is never checked against disk.
 */

import { posix } from 'node:path';

import type * as TS from 'typescript';

import { makeNodeId, normalizeRelativePath } from '../../graph/model.js';
import type {
  ChangeDetectionStrategy,
  ComponentNode,
  DirectiveNode,
  HostDirectiveRef,
  InputBinding,
  OutputBinding,
  PipeNode,
  ProvidedIn,
  ServiceNode,
  SignalNode,
} from '../../graph/model.js';

import { extractSignals } from './signals.js';

export interface ExtractDecoratorsResult {
  readonly nodes: readonly (ComponentNode | DirectiveNode | PipeNode | ServiceNode)[];
}

const LIFECYCLE_HOOK_NAMES: ReadonlySet<string> = new Set([
  'ngOnChanges',
  'ngOnInit',
  'ngDoCheck',
  'ngAfterContentInit',
  'ngAfterContentChecked',
  'ngAfterViewInit',
  'ngAfterViewChecked',
  'ngOnDestroy',
]);

// ---------------------------------------------------------------------------
// Low-level helpers (imports, decorators, object properties)
// ---------------------------------------------------------------------------

/** Map of local name -> imported name, for named imports from `moduleName`. */
function collectNamedImports(
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

/** Finds, among the decorators of `node`, the one that resolves to `importedName` via `coreImports`. */
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

/** First decorator argument, when it is an object literal (the Angular metadata). */
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

function readBooleanLiteral(typescript: typeof TS, expr: TS.Expression | undefined): boolean | undefined {
  if (!expr) return undefined;
  if (expr.kind === typescript.SyntaxKind.TrueKeyword) return true;
  if (expr.kind === typescript.SyntaxKind.FalseKeyword) return false;
  return undefined;
}

/** Resolves `templateUrl`/`styleUrl(s)` (relative to the component file) to a project path. */
function resolveSiblingPath(componentFilePath: string, relativeSpecifier: string): string {
  return normalizeRelativePath(posix.normalize(posix.join(posix.dirname(componentFilePath), relativeSpecifier)));
}

// ---------------------------------------------------------------------------
// @Input() / @Output() (decorator style)
// ---------------------------------------------------------------------------

function extractInputDecoratorBinding(
  typescript: typeof TS,
  member: TS.PropertyDeclaration,
  memberName: string,
  decorator: TS.Decorator,
  sourceFile: TS.SourceFile,
): InputBinding {
  const typeText = member.type?.getText(sourceFile);
  const arg = typescript.isCallExpression(decorator.expression) ? decorator.expression.arguments[0] : undefined;

  let alias: string | undefined;
  let required = false;

  if (arg && typescript.isStringLiteralLike(arg)) {
    alias = arg.text;
  } else if (arg && typescript.isObjectLiteralExpression(arg)) {
    const objProps = collectObjectProps(typescript, arg);
    const aliasProp = objProps.get('alias');
    if (aliasProp && typescript.isStringLiteralLike(aliasProp)) alias = aliasProp.text;
    required = readBooleanLiteral(typescript, objProps.get('required')) ?? false;
  }

  return { name: memberName, alias, typeText, required, isSignal: false };
}

function extractOutputDecoratorBinding(
  typescript: typeof TS,
  member: TS.PropertyDeclaration,
  memberName: string,
  decorator: TS.Decorator,
  sourceFile: TS.SourceFile,
): OutputBinding {
  let typeText = member.type?.getText(sourceFile);
  if (!typeText && member.initializer && typescript.isNewExpression(member.initializer)) {
    const typeArgs = member.initializer.typeArguments;
    const firstTypeArg = typeArgs?.[0];
    if (firstTypeArg) typeText = firstTypeArg.getText(sourceFile);
  }

  const arg = typescript.isCallExpression(decorator.expression) ? decorator.expression.arguments[0] : undefined;
  const alias = arg && typescript.isStringLiteralLike(arg) ? arg.text : undefined;

  return { name: memberName, alias, typeText, isSignal: false };
}

function extractDecoratorBindings(
  typescript: typeof TS,
  classDeclaration: TS.ClassDeclaration,
  coreImports: ReadonlyMap<string, string>,
  sourceFile: TS.SourceFile,
): { inputs: InputBinding[]; outputs: OutputBinding[] } {
  const inputs: InputBinding[] = [];
  const outputs: OutputBinding[] = [];

  for (const member of classDeclaration.members) {
    if (!typescript.isPropertyDeclaration(member) || !typescript.isIdentifier(member.name)) continue;
    const memberName = member.name.text;

    const inputDecorator = findDecoratorCall(typescript, member, coreImports, 'Input');
    if (inputDecorator) {
      inputs.push(extractInputDecoratorBinding(typescript, member, memberName, inputDecorator, sourceFile));
      continue;
    }

    const outputDecorator = findDecoratorCall(typescript, member, coreImports, 'Output');
    if (outputDecorator) {
      outputs.push(extractOutputDecoratorBinding(typescript, member, memberName, outputDecorator, sourceFile));
    }
  }

  return { inputs, outputs };
}

/** Adds the signal-based bindings (`input`, `output`, `model`) to `inputs`/`outputs`. */
function mergeSignalBindings(
  signalsForClass: readonly SignalNode[],
  inputs: InputBinding[],
  outputs: OutputBinding[],
): void {
  for (const signalNode of signalsForClass) {
    if (signalNode.signalKind === 'input') {
      inputs.push({
        name: signalNode.name,
        typeText: signalNode.typeText,
        required: signalNode.required,
        isSignal: true,
      });
    } else if (signalNode.signalKind === 'output') {
      outputs.push({ name: signalNode.name, typeText: signalNode.typeText, isSignal: true });
    } else if (signalNode.signalKind === 'model') {
      // `model()` is both an Input and an Output at once (two-way binding), see the Angular docs.
      inputs.push({
        name: signalNode.name,
        typeText: signalNode.typeText,
        required: signalNode.required,
        isSignal: true,
      });
      outputs.push({ name: signalNode.name, typeText: signalNode.typeText, isSignal: true });
    }
  }
}

// ---------------------------------------------------------------------------
// Lifecycle hooks and host bindings
// ---------------------------------------------------------------------------

function extractLifecycleHooks(typescript: typeof TS, classDeclaration: TS.ClassDeclaration): readonly string[] {
  const hooks: string[] = [];
  for (const member of classDeclaration.members) {
    if (
      typescript.isMethodDeclaration(member) &&
      typescript.isIdentifier(member.name) &&
      LIFECYCLE_HOOK_NAMES.has(member.name.text)
    ) {
      hooks.push(member.name.text);
    }
  }
  return hooks;
}

function extractHostBindingsFromMetadata(
  typescript: typeof TS,
  props: ReadonlyMap<string, TS.Expression>,
  sourceFile: TS.SourceFile,
): string[] {
  const hostProp = props.get('host');
  if (!hostProp || !typescript.isObjectLiteralExpression(hostProp)) return [];

  const result: string[] = [];
  for (const prop of hostProp.properties) {
    if (!typescript.isPropertyAssignment(prop)) continue;
    const key = propKeyName(typescript, prop.name);
    if (key === undefined) continue;
    result.push(`${key}: ${prop.initializer.getText(sourceFile)}`);
  }
  return result;
}

function extractHostBindingsFromMembers(
  typescript: typeof TS,
  classDeclaration: TS.ClassDeclaration,
  coreImports: ReadonlyMap<string, string>,
  sourceFile: TS.SourceFile,
): string[] {
  const result: string[] = [];

  for (const member of classDeclaration.members) {
    if (typescript.isPropertyDeclaration(member) && typescript.isIdentifier(member.name)) {
      const decorator = findDecoratorCall(typescript, member, coreImports, 'HostBinding');
      if (!decorator) continue;
      const arg = typescript.isCallExpression(decorator.expression) ? decorator.expression.arguments[0] : undefined;
      const hostProp = arg && typescript.isStringLiteralLike(arg) ? arg.text : member.name.text;
      result.push(`${hostProp}: ${member.name.text}`);
      continue;
    }

    if (typescript.isMethodDeclaration(member) && typescript.isIdentifier(member.name)) {
      const decorator = findDecoratorCall(typescript, member, coreImports, 'HostListener');
      if (!decorator || !typescript.isCallExpression(decorator.expression)) continue;
      const eventArg = decorator.expression.arguments[0];
      const eventName = eventArg && typescript.isStringLiteralLike(eventArg) ? eventArg.text : '';
      const argsArg = decorator.expression.arguments[1];
      const argsText =
        argsArg && typescript.isArrayLiteralExpression(argsArg)
          ? argsArg.elements.map((element) => element.getText(sourceFile)).join(', ')
          : '';
      result.push(`(${eventName}): ${member.name.text}(${argsText})`);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// @Component
// ---------------------------------------------------------------------------

function readChangeDetection(typescript: typeof TS, expr: TS.Expression | undefined): ChangeDetectionStrategy {
  if (expr && typescript.isPropertyAccessExpression(expr) && expr.name.text === 'OnPush') return 'OnPush';
  return 'Default';
}

function extractTemplateInfo(
  typescript: typeof TS,
  props: ReadonlyMap<string, TS.Expression>,
  filePath: string,
): { templatePath: string | undefined; inlineTemplate: boolean } {
  const templateUrlProp = props.get('templateUrl');
  if (templateUrlProp && typescript.isStringLiteralLike(templateUrlProp)) {
    return { templatePath: resolveSiblingPath(filePath, templateUrlProp.text), inlineTemplate: false };
  }
  return { templatePath: undefined, inlineTemplate: props.has('template') };
}

function extractStylePaths(
  typescript: typeof TS,
  props: ReadonlyMap<string, TS.Expression>,
  filePath: string,
): readonly string[] {
  const styleUrlProp = props.get('styleUrl');
  if (styleUrlProp && typescript.isStringLiteralLike(styleUrlProp)) {
    return [resolveSiblingPath(filePath, styleUrlProp.text)];
  }

  const styleUrlsProp = props.get('styleUrls');
  if (styleUrlsProp && typescript.isArrayLiteralExpression(styleUrlsProp)) {
    const paths: string[] = [];
    for (const element of styleUrlsProp.elements) {
      if (typescript.isStringLiteralLike(element)) paths.push(resolveSiblingPath(filePath, element.text));
    }
    return paths;
  }

  return [];
}

function extractComponentNode(
  typescript: typeof TS,
  classDeclaration: TS.ClassDeclaration,
  className: string,
  filePath: string,
  sourceFile: TS.SourceFile,
  props: ReadonlyMap<string, TS.Expression>,
  coreImports: ReadonlyMap<string, string>,
): ComponentNode {
  const selectorProp = props.get('selector');
  const selector = selectorProp && typescript.isStringLiteralLike(selectorProp) ? selectorProp.text : undefined;
  const standalone = readBooleanLiteral(typescript, props.get('standalone')) ?? true;
  const changeDetection = readChangeDetection(typescript, props.get('changeDetection'));
  const { templatePath, inlineTemplate } = extractTemplateInfo(typescript, props, filePath);
  const stylePaths = extractStylePaths(typescript, props, filePath);

  const { inputs, outputs } = extractDecoratorBindings(typescript, classDeclaration, coreImports, sourceFile);

  const classId = makeNodeId(filePath, className);
  const signalsForClass = extractSignals(typescript, sourceFile, filePath).filter(
    (node): node is SignalNode => node.kind === 'Signal' && node.ownerRef === classId,
  );
  mergeSignalBindings(signalsForClass, inputs, outputs);

  return {
    id: classId,
    kind: 'Component',
    path: filePath,
    name: className,
    selector,
    standalone,
    changeDetection,
    templatePath,
    inlineTemplate,
    stylePaths,
    inputs,
    outputs,
    signals: signalsForClass.map((node) => node.id),
    lifecycleHooks: extractLifecycleHooks(typescript, classDeclaration),
    hostBindings: [
      ...extractHostBindingsFromMetadata(typescript, props, sourceFile),
      ...extractHostBindingsFromMembers(typescript, classDeclaration, coreImports, sourceFile),
    ],
  };
}

// ---------------------------------------------------------------------------
// @Directive
// ---------------------------------------------------------------------------

function extractHostDirectives(
  typescript: typeof TS,
  props: ReadonlyMap<string, TS.Expression>,
  sourceFile: TS.SourceFile,
): readonly HostDirectiveRef[] {
  const prop = props.get('hostDirectives');
  if (!prop || !typescript.isArrayLiteralExpression(prop)) return [];

  const refs: HostDirectiveRef[] = [];
  for (const element of prop.elements) {
    if (typescript.isIdentifier(element)) {
      refs.push({ specifier: element.text, confidence: 'certain' });
      continue;
    }

    if (typescript.isObjectLiteralExpression(element)) {
      const objProps = collectObjectProps(typescript, element);
      const directiveProp = objProps.get('directive');
      if (directiveProp && typescript.isIdentifier(directiveProp)) {
        refs.push({ specifier: directiveProp.text, confidence: 'certain' });
        continue;
      }
    }

    refs.push({ specifier: element.getText(sourceFile), confidence: 'unknown' });
  }

  return refs;
}

function extractDirectiveNode(
  typescript: typeof TS,
  classDeclaration: TS.ClassDeclaration,
  className: string,
  filePath: string,
  sourceFile: TS.SourceFile,
  props: ReadonlyMap<string, TS.Expression>,
  coreImports: ReadonlyMap<string, string>,
): DirectiveNode {
  const selectorProp = props.get('selector');
  const selector = selectorProp && typescript.isStringLiteralLike(selectorProp) ? selectorProp.text : undefined;
  const standalone = readBooleanLiteral(typescript, props.get('standalone')) ?? true;

  const { inputs, outputs } = extractDecoratorBindings(typescript, classDeclaration, coreImports, sourceFile);

  const classId = makeNodeId(filePath, className);
  const signalsForClass = extractSignals(typescript, sourceFile, filePath).filter(
    (node): node is SignalNode => node.kind === 'Signal' && node.ownerRef === classId,
  );
  mergeSignalBindings(signalsForClass, inputs, outputs);

  return {
    id: classId,
    kind: 'Directive',
    path: filePath,
    name: className,
    selector,
    standalone,
    inputs,
    outputs,
    hostDirectives: extractHostDirectives(typescript, props, sourceFile),
  };
}

// ---------------------------------------------------------------------------
// @Pipe / @Injectable
// ---------------------------------------------------------------------------

function extractPipeNode(
  typescript: typeof TS,
  className: string,
  filePath: string,
  props: ReadonlyMap<string, TS.Expression>,
): PipeNode {
  const nameProp = props.get('name');
  const name = nameProp && typescript.isStringLiteralLike(nameProp) ? nameProp.text : className;
  const standalone = readBooleanLiteral(typescript, props.get('standalone')) ?? true;
  const pure = readBooleanLiteral(typescript, props.get('pure')) ?? true;

  return {
    id: makeNodeId(filePath, className),
    kind: 'Pipe',
    path: filePath,
    name,
    standalone,
    pure,
  };
}

function extractServiceNode(
  typescript: typeof TS,
  className: string,
  filePath: string,
  props: ReadonlyMap<string, TS.Expression>,
): ServiceNode {
  const providedInProp = props.get('providedIn');
  let providedIn: ProvidedIn = 'none';

  if (providedInProp) {
    if (typescript.isStringLiteralLike(providedInProp)) {
      const text = providedInProp.text;
      providedIn = text === 'root' || text === 'platform' || text === 'any' ? text : 'none';
    } else {
      providedIn = 'module';
    }
  }

  return {
    id: makeNodeId(filePath, className),
    kind: 'Service',
    path: filePath,
    name: className,
    providedIn,
    isInjectable: true,
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Extracts the `Component`, `Directive`, `Pipe` and `Service` nodes declared in
 * `sourceFile`. `relativePath` is the path relative to the root of the analyzed
 * project (see `NodeId` in graph/model.ts).
 */
export function extractDecorators(
  typescript: typeof TS,
  sourceFile: TS.SourceFile,
  relativePath: string,
): ExtractDecoratorsResult {
  const filePath = normalizeRelativePath(relativePath);
  const coreImports = collectNamedImports(typescript, sourceFile, '@angular/core');
  const nodes: (ComponentNode | DirectiveNode | PipeNode | ServiceNode)[] = [];

  function processClass(classDeclaration: TS.ClassDeclaration, className: string): void {
    const componentDecorator = findDecoratorCall(typescript, classDeclaration, coreImports, 'Component');
    if (componentDecorator) {
      const props = collectObjectProps(typescript, getDecoratorMetadata(typescript, componentDecorator));
      nodes.push(extractComponentNode(typescript, classDeclaration, className, filePath, sourceFile, props, coreImports));
      return;
    }

    const directiveDecorator = findDecoratorCall(typescript, classDeclaration, coreImports, 'Directive');
    if (directiveDecorator) {
      const props = collectObjectProps(typescript, getDecoratorMetadata(typescript, directiveDecorator));
      nodes.push(extractDirectiveNode(typescript, classDeclaration, className, filePath, sourceFile, props, coreImports));
      return;
    }

    const pipeDecorator = findDecoratorCall(typescript, classDeclaration, coreImports, 'Pipe');
    if (pipeDecorator) {
      const props = collectObjectProps(typescript, getDecoratorMetadata(typescript, pipeDecorator));
      nodes.push(extractPipeNode(typescript, className, filePath, props));
      return;
    }

    const injectableDecorator = findDecoratorCall(typescript, classDeclaration, coreImports, 'Injectable');
    if (injectableDecorator) {
      const props = collectObjectProps(typescript, getDecoratorMetadata(typescript, injectableDecorator));
      nodes.push(extractServiceNode(typescript, className, filePath, props));
    }
  }

  function visit(node: TS.Node): void {
    if (typescript.isClassDeclaration(node) && node.name) {
      processClass(node, node.name.text);
    }
    typescript.forEachChild(node, visit);
  }

  visit(sourceFile);
  return { nodes };
}
