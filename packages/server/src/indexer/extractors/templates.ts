/**
 * Template extractor. See docs/PLAN.md, sections 4.2, 4.3, 5.1, 5.2, 9.1 and
 * risks R4 and R14.
 *
 * Templates are parsed with `parseTemplate` from the ANALYZED PROJECT's own
 * `@angular/compiler` (never a version bundled with the server, P5/4.2):
 * `angularCompiler` is the `unknown` module handed back by
 * `resolveProjectDependencies()` in `resolve.ts`, cast here through a minimal
 * structural interface of exactly what this file uses.
 *
 * R14: a template with a syntax error must never abort the index. `parseTemplate`
 * itself does not throw on a malformed template (it returns `errors`), so the
 * `TemplateNode` is built and its (possibly partial) `nodes` are still walked;
 * only a genuinely unexpected exception from the compiler call is caught and
 * turned into a single parse error, never rethrown.
 *
 * Emits:
 *  - one `Template` node with `parseErrors` (R14, never omitted, never aborts);
 *  - a `renders` edge (the owning Component -> this Template);
 *  - a `binds` edge per resolvable binding occurrence (interpolation, property,
 *    event, two-way, control-flow, via `BindingType`/`ParsedEventType` from the
 *    compiler itself, never guessed from source text);
 *  - a `uses_in_template` edge per element/attribute/pipe name that resolves
 *    against the `ComponentScope` computed by `selectors.ts` (R4). Omitted
 *    entirely when no scope is given: an unresolved scope is not a guess.
 *
 * A bound expression's "member" is the outermost property access rooted at the
 * component instance itself (`ImplicitReceiver`/`ThisReceiver`), e.g. `user` in
 * `user.name`, or `onClick` in `onClick()`. Template-local names (loop
 * variables, `#ref`s, `@let` declarations, `$event`) are tracked while walking
 * and are never reported as a member: they do not exist on the component.
 */

import { makeNodeId, normalizeRelativePath, parseNodeId } from '../../graph/model.js';
import type {
  BindingKind,
  BindsEdge,
  GraphEdge,
  NodeId,
  ParseError,
  Provenance,
  RendersEdge,
  TemplateNode,
  UsesInTemplateEdge,
} from '../../graph/model.js';

import { matchSelector } from './selectors.js';
import type { ComponentScope } from './selectors.js';

// ---------------------------------------------------------------------------
// The slice of `@angular/compiler` this file depends on
// ---------------------------------------------------------------------------

/** Only used for `instanceof` checks against the compiler's own AST classes. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ClassRef = abstract new (...args: any[]) => object;

interface BindingTypeEnum {
  readonly Property: number;
  readonly Attribute: number;
  readonly Class: number;
  readonly Style: number;
  readonly Animation: number;
  readonly TwoWay: number;
}

interface ParsedEventTypeEnum {
  readonly Regular: number;
  readonly Animation: number;
  readonly TwoWay: number;
}

interface CompilerParseErrorLike {
  readonly msg: string;
  readonly span?: { readonly start?: { readonly line?: number; readonly col?: number } };
}

interface CompilerParseResult {
  readonly errors: readonly CompilerParseErrorLike[] | null;
  readonly nodes: readonly unknown[];
}

interface AngularCompilerApi {
  readonly parseTemplate: (template: string, templateUrl: string, options?: Record<string, unknown>) => CompilerParseResult;

  readonly TmplAstElement: ClassRef;
  readonly TmplAstTemplate: ClassRef;
  readonly TmplAstBoundText: ClassRef;
  readonly TmplAstBoundAttribute: ClassRef;
  readonly TmplAstBoundEvent: ClassRef;
  readonly TmplAstTextAttribute: ClassRef;
  readonly TmplAstLetDeclaration: ClassRef;
  readonly TmplAstIfBlock: ClassRef;
  readonly TmplAstForLoopBlock: ClassRef;
  readonly TmplAstSwitchBlock: ClassRef;
  readonly TmplAstDeferredBlock: ClassRef;

  readonly PropertyRead: ClassRef;
  readonly SafePropertyRead: ClassRef;
  readonly PropertyWrite: ClassRef;
  readonly KeyedRead: ClassRef;
  readonly SafeKeyedRead: ClassRef;
  readonly KeyedWrite: ClassRef;
  readonly Call: ClassRef;
  readonly SafeCall: ClassRef;
  readonly Binary: ClassRef;
  readonly Conditional: ClassRef;
  readonly Interpolation: ClassRef;
  readonly Chain: ClassRef;
  readonly LiteralArray: ClassRef;
  readonly LiteralMap: ClassRef;
  readonly BindingPipe: ClassRef;
  readonly ImplicitReceiver: ClassRef;
  readonly ThisReceiver: ClassRef;
  readonly NonNullAssert: ClassRef;
  readonly PrefixNot: ClassRef;
  readonly Unary: ClassRef;

  readonly BindingType: BindingTypeEnum;
  readonly ParsedEventType: ParsedEventTypeEnum;
}

function asCompilerApi(angularCompiler: unknown): AngularCompilerApi {
  const candidate = angularCompiler as Partial<AngularCompilerApi> | null | undefined;
  if (!candidate || typeof candidate.parseTemplate !== 'function') {
    throw new Error(
      "extractTemplate() received an 'angularCompiler' module that does not expose parseTemplate(). " +
        'Pass the module returned by resolveProjectDependencies() for the analyzed project.',
    );
  }
  return candidate as AngularCompilerApi;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ExtractTemplateOptions {
  /** The `@angular/compiler` module resolved from the analyzed project (see resolve.ts). */
  readonly angularCompiler: unknown;
  readonly templateSource: string;
  /** Relative path of the template itself: the component's own file when inline, or the `.html` file. */
  readonly templatePath: string;
  readonly inline: boolean;
  /** NodeId of the Component that renders this template. */
  readonly ownerRef: NodeId;
  /** Relative path of the owning component's own file (targets of `binds` edges live there). */
  readonly ownerFilePath: string;
  /** Selector scope of the owning component, from `selectors.ts`. Omitted -> no `uses_in_template` edges. */
  readonly scope?: ComponentScope;
  /** Known signal/observable member names of the owning component, to refine `BindsEdge.targetKind`. */
  readonly memberKinds?: ReadonlyMap<string, 'signal' | 'observable'>;
}

export interface ExtractTemplateResult {
  readonly templateNode: TemplateNode;
  readonly edges: readonly GraphEdge[];
}

/**
 * Parses one template (inline or external) with the analyzed project's own
 * compiler and extracts its `Template` node and its `binds`/`uses_in_template`/
 * `renders` edges. Never throws: a syntax error becomes a `parseErrors` entry
 * on the returned node (R14).
 */
export function extractTemplate(options: ExtractTemplateOptions): ExtractTemplateResult {
  const { angularCompiler, templateSource, inline, ownerRef, scope, memberKinds } = options;
  const templatePath = normalizeRelativePath(options.templatePath);
  const ownerFilePath = normalizeRelativePath(options.ownerFilePath);
  const api = asCompilerApi(angularCompiler);

  const templateName = `${parseNodeId(ownerRef).symbol}.template`;
  const templateId = makeNodeId(templatePath, templateName);

  let parseResult: CompilerParseResult;
  try {
    parseResult = api.parseTemplate(templateSource, templatePath, { preserveWhitespaces: false });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      templateNode: { id: templateId, kind: 'Template', path: templatePath, name: templateName, inline, parseErrors: [{ message }] },
      edges: [],
    };
  }

  const parseErrors: ParseError[] = (parseResult.errors ?? []).map((error) => ({
    message: error.msg,
    line: typeof error.span?.start?.line === 'number' ? error.span.start.line + 1 : undefined,
    column: typeof error.span?.start?.col === 'number' ? error.span.start.col + 1 : undefined,
  }));

  const templateNode: TemplateNode = { id: templateId, kind: 'Template', path: templatePath, name: templateName, inline, parseErrors };

  const rendersEdge: RendersEdge = {
    kind: 'renders',
    from: ownerRef,
    to: templateId,
    provenance: { file: templatePath, line: 1, column: 1 },
    confidence: 'certain',
  };

  const edges: GraphEdge[] = [rendersEdge];
  const ctx: WalkCtx = { api, templateId, templatePath, ownerFilePath, scope, memberKinds, edges };

  // `$event` is never a component member; it is always the local event-object
  // implicitly bound inside a `(event)="..."` handler.
  walkSiblings(parseResult.nodes, ctx, new Set(['$event']));

  return { templateNode, edges };
}

// ---------------------------------------------------------------------------
// Tree walk
// ---------------------------------------------------------------------------

type LocalScope = ReadonlySet<string>;

interface WalkCtx {
  readonly api: AngularCompilerApi;
  readonly templateId: NodeId;
  readonly templatePath: string;
  readonly ownerFilePath: string;
  readonly scope?: ComponentScope;
  readonly memberKinds?: ReadonlyMap<string, 'signal' | 'observable'>;
  readonly edges: GraphEdge[];
}

interface SpanLike {
  readonly sourceSpan?: { readonly start?: { readonly line?: number; readonly col?: number } };
}

function spanToProvenance(node: unknown, templatePath: string): Provenance {
  const start = (node as SpanLike | undefined)?.sourceSpan?.start;
  const line = typeof start?.line === 'number' ? start.line + 1 : 1;
  const column = typeof start?.col === 'number' ? start.col + 1 : 1;
  return { file: templatePath, line, column };
}

function withLocals(locals: LocalScope, names: Iterable<string>): LocalScope {
  const next = new Set(locals);
  for (const name of names) next.add(name);
  return next;
}

function namesOf(items: readonly unknown[] | undefined): readonly string[] {
  return (items ?? [])
    .map((item) => (item as { name?: unknown }).name)
    .filter((name): name is string => typeof name === 'string');
}

function unwrapAst(value: unknown): unknown {
  if (value && typeof value === 'object' && 'ast' in value) {
    return (value as { ast: unknown }).ast;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Expression walk: which component member(s) a bound expression reads/calls
// ---------------------------------------------------------------------------

interface ResolvedMember {
  readonly name: string;
  readonly viaCall: boolean;
}

function isRootReceiver(api: AngularCompilerApi, node: unknown): boolean {
  return node instanceof api.ImplicitReceiver || node instanceof api.ThisReceiver;
}

function isPropertyReadLike(
  api: AngularCompilerApi,
  node: unknown,
): node is { name: string; receiver: unknown; value?: unknown } {
  return node instanceof api.PropertyRead || node instanceof api.SafePropertyRead || node instanceof api.PropertyWrite;
}

function isKeyedLike(api: AngularCompilerApi, node: unknown): node is { receiver: unknown; key: unknown; value?: unknown } {
  return node instanceof api.KeyedRead || node instanceof api.SafeKeyedRead || node instanceof api.KeyedWrite;
}

/** Walks a bound-expression AST, collecting every root component member it reads or calls, and every pipe it uses. */
function collectMembers(
  api: AngularCompilerApi,
  node: unknown,
  locals: LocalScope,
  members: ResolvedMember[],
  pipeNames: string[],
): void {
  if (!node || typeof node !== 'object') return;

  if (node instanceof api.BindingPipe) {
    const pipe = node as { exp: unknown; args?: unknown[]; name: string };
    pipeNames.push(pipe.name);
    collectMembers(api, pipe.exp, locals, members, pipeNames);
    for (const arg of pipe.args ?? []) collectMembers(api, arg, locals, members, pipeNames);
    return;
  }

  if (node instanceof api.Interpolation || node instanceof api.Chain || node instanceof api.LiteralArray) {
    const withExpressions = node as { expressions?: unknown[] };
    for (const expr of withExpressions.expressions ?? []) collectMembers(api, expr, locals, members, pipeNames);
    return;
  }

  if (node instanceof api.LiteralMap) {
    const literalMap = node as { values?: unknown[] };
    for (const value of literalMap.values ?? []) collectMembers(api, value, locals, members, pipeNames);
    return;
  }

  if (node instanceof api.Binary) {
    const binary = node as { left: unknown; right: unknown };
    collectMembers(api, binary.left, locals, members, pipeNames);
    collectMembers(api, binary.right, locals, members, pipeNames);
    return;
  }

  if (node instanceof api.Conditional) {
    const conditional = node as { condition: unknown; trueExp: unknown; falseExp: unknown };
    collectMembers(api, conditional.condition, locals, members, pipeNames);
    collectMembers(api, conditional.trueExp, locals, members, pipeNames);
    collectMembers(api, conditional.falseExp, locals, members, pipeNames);
    return;
  }

  if (node instanceof api.NonNullAssert || node instanceof api.PrefixNot || node instanceof api.Unary) {
    const wrapped = node as { expression: unknown };
    collectMembers(api, wrapped.expression, locals, members, pipeNames);
    return;
  }

  if (node instanceof api.Call || node instanceof api.SafeCall) {
    const call = node as { receiver: unknown; args?: unknown[] };
    if (isPropertyReadLike(api, call.receiver) && isRootReceiver(api, call.receiver.receiver)) {
      if (!locals.has(call.receiver.name)) members.push({ name: call.receiver.name, viaCall: true });
    } else {
      collectMembers(api, call.receiver, locals, members, pipeNames);
    }
    for (const arg of call.args ?? []) collectMembers(api, arg, locals, members, pipeNames);
    return;
  }

  if (isPropertyReadLike(api, node)) {
    if (isRootReceiver(api, node.receiver)) {
      if (!locals.has(node.name)) members.push({ name: node.name, viaCall: false });
    } else {
      collectMembers(api, node.receiver, locals, members, pipeNames);
    }
    if (node.value !== undefined) collectMembers(api, node.value, locals, members, pipeNames);
    return;
  }

  if (isKeyedLike(api, node)) {
    collectMembers(api, node.receiver, locals, members, pipeNames);
    collectMembers(api, node.key, locals, members, pipeNames);
    if (node.value !== undefined) collectMembers(api, node.value, locals, members, pipeNames);
    return;
  }
}

function classifyAttributeBinding(api: AngularCompilerApi, type: number): BindingKind {
  if (type === api.BindingType.Property) return 'property';
  if (type === api.BindingType.TwoWay) return 'two-way';
  return 'attribute';
}

function classifyEventBinding(api: AngularCompilerApi, type: number): BindingKind {
  return type === api.ParsedEventType.TwoWay ? 'two-way' : 'event';
}

/** Emits a `binds` edge per member found in `exprField` (unwrapped from its `ASTWithSource`), and `uses_in_template` for pipes. */
function emitBindingEdges(ctx: WalkCtx, container: unknown, exprField: unknown, locals: LocalScope, bindingKind: BindingKind): void {
  const ast = unwrapAst(exprField);
  if (!ast) return;

  const members: ResolvedMember[] = [];
  const pipeNames: string[] = [];
  collectMembers(ctx.api, ast, locals, members, pipeNames);

  const provenance = spanToProvenance(container, ctx.templatePath);

  for (const member of members) {
    const bindsEdge: BindsEdge = {
      kind: 'binds',
      from: ctx.templateId,
      to: makeNodeId(ctx.ownerFilePath, member.name),
      provenance,
      confidence: 'certain',
      bindingKind,
      memberName: member.name,
      targetKind: ctx.memberKinds?.get(member.name) ?? (member.viaCall ? 'method' : 'property'),
    };
    ctx.edges.push(bindsEdge);
  }

  if (!ctx.scope || pipeNames.length === 0) return;
  for (const pipeName of pipeNames) {
    for (const match of matchSelector(ctx.scope, pipeName)) {
      if (match.targetKind !== 'Pipe') continue;
      const usesEdge: UsesInTemplateEdge = {
        kind: 'uses_in_template',
        from: ctx.templateId,
        to: match.targetRef,
        provenance,
        confidence: match.confidence,
        selector: pipeName,
      };
      ctx.edges.push(usesEdge);
    }
  }
}

// ---------------------------------------------------------------------------
// Element/template selector matching
// ---------------------------------------------------------------------------

interface BindableShape {
  /** The tag name on a `TmplAstElement`. */
  readonly name?: string;
  /** The underlying tag name on a `TmplAstTemplate` (a structural-directive host). */
  readonly tagName?: string;
  readonly attributes?: readonly unknown[];
  readonly inputs?: readonly unknown[];
  readonly outputs?: readonly unknown[];
  readonly templateAttrs?: readonly unknown[];
}

function handleBindings(node: BindableShape, ctx: WalkCtx, locals: LocalScope): void {
  const api = ctx.api;

  for (const input of node.inputs ?? []) {
    if (input instanceof api.TmplAstBoundAttribute) {
      const bound = input as { value: unknown; type: number };
      emitBindingEdges(ctx, input, bound.value, locals, classifyAttributeBinding(api, bound.type));
    }
  }

  for (const output of node.outputs ?? []) {
    if (output instanceof api.TmplAstBoundEvent) {
      const bound = output as { handler: unknown; type: number };
      emitBindingEdges(ctx, output, bound.handler, locals, classifyEventBinding(api, bound.type));
    }
  }

  for (const attr of node.templateAttrs ?? []) {
    if (attr instanceof api.TmplAstBoundAttribute) {
      const bound = attr as { value: unknown };
      emitBindingEdges(ctx, attr, bound.value, locals, 'control-flow');
    }
  }
}

function collectSelectorCandidates(node: BindableShape, api: AngularCompilerApi): readonly string[] {
  const tokens = new Set<string>();
  const tagName = node.tagName ?? node.name;
  if (typeof tagName === 'string') tokens.add(tagName);

  for (const attr of node.attributes ?? []) {
    if (attr instanceof api.TmplAstTextAttribute) tokens.add((attr as { name: string }).name);
  }

  for (const input of node.inputs ?? []) {
    if (input instanceof api.TmplAstBoundAttribute) {
      const bound = input as { name: string; type: number };
      if (bound.type === api.BindingType.Property || bound.type === api.BindingType.TwoWay || bound.type === api.BindingType.Attribute) {
        tokens.add(bound.name);
      }
    }
  }

  for (const output of node.outputs ?? []) {
    if (output instanceof api.TmplAstBoundEvent) tokens.add((output as { name: string }).name);
  }

  for (const attr of node.templateAttrs ?? []) {
    const named = attr as { name?: unknown };
    if (typeof named.name === 'string') tokens.add(named.name);
  }

  return [...tokens];
}

function emitUsesInTemplateEdges(node: BindableShape, ctx: WalkCtx): void {
  if (!ctx.scope) return;
  const provenance = spanToProvenance(node, ctx.templatePath);

  for (const token of collectSelectorCandidates(node, ctx.api)) {
    for (const match of matchSelector(ctx.scope, token)) {
      if (match.targetKind === 'Pipe') continue;
      const usesEdge: UsesInTemplateEdge = {
        kind: 'uses_in_template',
        from: ctx.templateId,
        to: match.targetRef,
        provenance,
        confidence: match.confidence,
        selector: token,
      };
      ctx.edges.push(usesEdge);
    }
  }
}

// ---------------------------------------------------------------------------
// Node dispatch
// ---------------------------------------------------------------------------

function walkSiblings(nodes: readonly unknown[] | undefined, ctx: WalkCtx, locals: LocalScope): void {
  let currentLocals = locals;

  for (const node of nodes ?? []) {
    if (node instanceof ctx.api.TmplAstLetDeclaration) {
      const decl = node as { name: string; value: unknown };
      emitBindingEdges(ctx, decl, decl.value, currentLocals, 'control-flow');
      currentLocals = withLocals(currentLocals, [decl.name]);
      continue;
    }
    walkNode(node, ctx, currentLocals);
  }
}

function walkNode(node: unknown, ctx: WalkCtx, locals: LocalScope): void {
  const api = ctx.api;

  if (node instanceof api.TmplAstElement) {
    const element = node as BindableShape & { references?: readonly unknown[]; children?: readonly unknown[] };
    handleBindings(element, ctx, locals);
    emitUsesInTemplateEdges(element, ctx);
    walkSiblings(element.children, ctx, withLocals(locals, namesOf(element.references)));
    return;
  }

  if (node instanceof api.TmplAstTemplate) {
    const template = node as BindableShape & {
      references?: readonly unknown[];
      variables?: readonly unknown[];
      children?: readonly unknown[];
    };
    handleBindings(template, ctx, locals);
    emitUsesInTemplateEdges(template, ctx);
    const childLocals = withLocals(withLocals(locals, namesOf(template.references)), namesOf(template.variables));
    walkSiblings(template.children, ctx, childLocals);
    return;
  }

  if (node instanceof api.TmplAstBoundText) {
    const boundText = node as { value: unknown };
    emitBindingEdges(ctx, boundText, boundText.value, locals, 'interpolation');
    return;
  }

  if (node instanceof api.TmplAstIfBlock) {
    const ifBlock = node as {
      branches: readonly { expression: unknown | null; expressionAlias?: { name: string } | null; children?: readonly unknown[] }[];
    };
    for (const branch of ifBlock.branches) {
      if (branch.expression) emitBindingEdges(ctx, branch, branch.expression, locals, 'control-flow');
      const branchLocals = branch.expressionAlias ? withLocals(locals, [branch.expressionAlias.name]) : locals;
      walkSiblings(branch.children, ctx, branchLocals);
    }
    return;
  }

  if (node instanceof api.TmplAstForLoopBlock) {
    const forBlock = node as {
      expression: unknown;
      item: { name: string };
      contextVariables?: readonly { name: string }[];
      children?: readonly unknown[];
    };
    emitBindingEdges(ctx, forBlock, forBlock.expression, locals, 'control-flow');
    const loopLocals = withLocals(withLocals(locals, [forBlock.item.name]), namesOf(forBlock.contextVariables));
    walkSiblings(forBlock.children, ctx, loopLocals);
    return;
  }

  if (node instanceof api.TmplAstSwitchBlock) {
    const switchBlock = node as {
      expression: unknown;
      cases: readonly { expression: unknown | null; children?: readonly unknown[] }[];
    };
    emitBindingEdges(ctx, switchBlock, switchBlock.expression, locals, 'control-flow');
    for (const switchCase of switchBlock.cases) {
      if (switchCase.expression) emitBindingEdges(ctx, switchCase, switchCase.expression, locals, 'control-flow');
      walkSiblings(switchCase.children, ctx, locals);
    }
    return;
  }

  if (node instanceof api.TmplAstDeferredBlock) {
    const deferredBlock = node as { children?: readonly unknown[] };
    walkSiblings(deferredBlock.children, ctx, locals);
    return;
  }

  const generic = node as { children?: readonly unknown[] };
  if (Array.isArray(generic.children)) walkSiblings(generic.children, ctx, locals);
}
