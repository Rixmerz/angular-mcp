/**
 * Data model of the project graph. See docs/PLAN.md, section 5.
 *
 * Contract for the extractors (packages/server/src/indexer/extractors/*): each
 * extractor produces GraphNode[] and GraphEdge[] from a ts.SourceFile (or a
 * template), with no side effects.
 *
 * Principle P1 of the plan: nothing that cannot be rederived from the code is
 * persisted as truth. These types describe derived facts, never hand-editable
 * state.
 */

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * Unique identifier of a node: `relative/path/to/file.ts#SymbolName`. Never
 * just the name (R13: several `UserListComponent` classes in one monorepo is a
 * real case). The path is always relative to the root of the analyzed project,
 * with `/` separators.
 */
export type NodeId = string;

/** Builds a NodeId from a relative path and a symbol. */
export function makeNodeId(relativePath: string, symbol: string): NodeId {
  const normalized = normalizeRelativePath(relativePath);
  if (symbol.length === 0) {
    throw new Error(`makeNodeId: empty symbol for "${normalized}"`);
  }
  return `${normalized}#${symbol}`;
}

/** Splits a NodeId into its file path and its symbol. */
export function parseNodeId(id: NodeId): { path: string; symbol: string } {
  const hashIndex = id.indexOf('#');
  if (hashIndex === -1) {
    throw new Error(`Invalid NodeId, missing "#path#symbol": "${id}"`);
  }
  return { path: id.slice(0, hashIndex), symbol: id.slice(hashIndex + 1) };
}

/** Normalizes path separators to `/` and strips a leading `./`. */
export function normalizeRelativePath(relativePath: string): string {
  const withForwardSlashes = relativePath.replace(/\\/g, '/');
  return withForwardSlashes.startsWith('./') ? withForwardSlashes.slice(2) : withForwardSlashes;
}

// ---------------------------------------------------------------------------
// Provenance and confidence (P4, R7)
// ---------------------------------------------------------------------------

/** Where a fact came from: file, line and column, 1-based. */
export interface Provenance {
  readonly file: string;
  readonly line: number;
  readonly column: number;
}

/**
 * Confidence level of a fact. Nothing is ever guessed: whatever cannot be
 * resolved is `unknown`, never a made-up value (R3, R7).
 */
export type Confidence = 'certain' | 'inferred' | 'unknown';

// ---------------------------------------------------------------------------
// Nodes — table 5.1
// ---------------------------------------------------------------------------

export type NodeKind =
  | 'Component'
  | 'Directive'
  | 'Pipe'
  | 'Service'
  | 'NgModule'
  | 'Route'
  | 'Guard'
  | 'Resolver'
  | 'Interceptor'
  | 'Template'
  | 'Signal'
  | 'Observable'
  | 'HttpCall'
  | 'Spec'
  | 'Model'
  | 'Class'
  | 'File';

export interface NodeBase<K extends NodeKind = NodeKind> {
  readonly id: NodeId;
  readonly kind: K;
  /** Relative path of the file the node was derived from. */
  readonly path: string;
  /** Symbol name (or a synthetic name for nodes with no TS symbol). */
  readonly name: string;
}

export type ChangeDetectionStrategy = 'Default' | 'OnPush';

export interface InputBinding {
  readonly name: string;
  readonly alias?: string;
  readonly typeText?: string;
  readonly required: boolean;
  /** true when declared with the `input()`/`input.required()` function, false for `@Input()`. */
  readonly isSignal: boolean;
}

export interface OutputBinding {
  readonly name: string;
  readonly alias?: string;
  readonly typeText?: string;
  /** true when declared with the `output()` function, false for `@Output()`. */
  readonly isSignal: boolean;
}

export interface HostDirectiveRef {
  readonly specifier: string;
  readonly confidence: Confidence;
}

export interface ComponentNode extends NodeBase<'Component'> {
  readonly selector?: string;
  readonly standalone: boolean;
  readonly changeDetection: ChangeDetectionStrategy;
  readonly templatePath?: string;
  readonly inlineTemplate: boolean;
  readonly stylePaths: readonly string[];
  readonly inputs: readonly InputBinding[];
  readonly outputs: readonly OutputBinding[];
  /** NodeIds of the Signal nodes declared by this component. */
  readonly signals: readonly NodeId[];
  readonly lifecycleHooks: readonly string[];
  readonly hostBindings: readonly string[];
}

export interface DirectiveNode extends NodeBase<'Directive'> {
  readonly selector?: string;
  readonly standalone: boolean;
  readonly inputs: readonly InputBinding[];
  readonly outputs: readonly OutputBinding[];
  readonly hostDirectives: readonly HostDirectiveRef[];
}

export interface PipeNode extends NodeBase<'Pipe'> {
  readonly standalone: boolean;
  readonly pure: boolean;
}

export type ProvidedIn = 'root' | 'platform' | 'any' | 'module' | 'none';

export interface ServiceNode extends NodeBase<'Service'> {
  readonly providedIn: ProvidedIn;
  readonly isInjectable: boolean;
}

export interface NgModuleNode extends NodeBase<'NgModule'> {
  /** Specifiers exactly as they appear in the decorator; the edges are the graph's truth. */
  readonly declarations: readonly string[];
  readonly imports: readonly string[];
  readonly exports: readonly string[];
  readonly providers: readonly string[];
}

export type RouteLazyLoading =
  | { readonly kind: 'loadComponent' | 'loadChildren'; readonly specifier: string; readonly confidence: Confidence }
  | false;

export interface RouteNode extends NodeBase<'Route'> {
  readonly routePath: string;
  readonly componentRef?: NodeId;
  readonly lazy: RouteLazyLoading;
  readonly guards: readonly NodeId[];
  readonly resolvers: readonly NodeId[];
  readonly children: readonly NodeId[];
  readonly data?: Readonly<Record<string, unknown>>;
}

export type SymbolKind = 'class' | 'functional';

export interface GuardNode extends NodeBase<'Guard'> {
  readonly guardKind: SymbolKind;
}

export interface ResolverNode extends NodeBase<'Resolver'> {
  readonly resolverKind: SymbolKind;
}

export interface InterceptorNode extends NodeBase<'Interceptor'> {
  readonly interceptorKind: SymbolKind;
}

export interface ParseError {
  readonly message: string;
  readonly line?: number;
  readonly column?: number;
}

export interface TemplateNode extends NodeBase<'Template'> {
  readonly inline: boolean;
  readonly parseErrors: readonly ParseError[];
}

export type SignalKind =
  | 'signal'
  | 'computed'
  | 'linkedSignal'
  | 'input'
  | 'model'
  | 'output'
  | 'viewChild'
  | 'viewChildren'
  | 'contentChild'
  | 'contentChildren'
  | 'resource'
  | 'httpResource'
  | 'toSignal';

export interface SignalNode extends NodeBase<'Signal'> {
  readonly ownerRef: NodeId;
  readonly signalKind: SignalKind;
  readonly required: boolean;
  readonly typeText?: string;
  readonly initialValueText?: string;
}

export interface ObservableNode extends NodeBase<'Observable'> {
  readonly ownerRef: NodeId;
  readonly typeText?: string;
}

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete' | 'head' | 'options';
export type UrlConfidence = 'literal' | 'template' | 'unknown';

export interface HttpCallNode extends NodeBase<'HttpCall'> {
  readonly method: HttpMethod;
  readonly urlPattern: string;
  readonly urlConfidence: UrlConfidence;
  readonly requestTypeText?: string;
  readonly responseTypeText?: string;
  readonly callerRef: NodeId;
}

export interface SpecNode extends NodeBase<'Spec'> {
  readonly describes: readonly string[];
  readonly testedRefs: readonly NodeId[];
}

export type ModelDeclarationKind = 'interface' | 'type' | 'class';

export interface ModelNode extends NodeBase<'Model'> {
  readonly declarationKind: ModelDeclarationKind;
}

/**
 * A generic class not covered by another node kind (an abstract base class with
 * no decorator, for example). It exists so the `extends` edge always has a
 * target node, even when the class is not an Angular concept.
 */
export interface ClassNode extends NodeBase<'Class'> {
  readonly isAbstract: boolean;
}

export interface FileNode extends NodeBase<'File'> {
  readonly hash: string;
  readonly lastIndexed: number;
}

export type GraphNode =
  | ComponentNode
  | DirectiveNode
  | PipeNode
  | ServiceNode
  | NgModuleNode
  | RouteNode
  | GuardNode
  | ResolverNode
  | InterceptorNode
  | TemplateNode
  | SignalNode
  | ObservableNode
  | HttpCallNode
  | SpecNode
  | ModelNode
  | ClassNode
  | FileNode;

/** Nodes that represent a declared symbol (used by the `tested_by` edge). */
export type SymbolNode = Exclude<GraphNode, FileNode | TemplateNode | RouteNode | HttpCallNode>;

// ---------------------------------------------------------------------------
// Edges — table 5.2
// ---------------------------------------------------------------------------

export type EdgeKind =
  | 'declares'
  | 'injects'
  | 'provides'
  | 'imports'
  | 'renders'
  | 'uses_in_template'
  | 'binds'
  | 'emits'
  | 'routes_to'
  | 'child_of'
  | 'guarded_by'
  | 'resolves_with'
  | 'calls_http'
  | 'intercepted_by'
  | 'returns'
  | 'tested_by'
  | 'extends';

export interface EdgeBase<K extends EdgeKind = EdgeKind> {
  readonly kind: K;
  readonly from: NodeId;
  readonly to: NodeId;
  readonly provenance: Provenance;
  readonly confidence: Confidence;
}

/** `declares`: File -> Symbol */
export type DeclaresEdge = EdgeBase<'declares'>;

/** `injects`: Component|Directive|Service|Guard -> Service (constructor or inject()) */
export interface InjectsEdge extends EdgeBase<'injects'> {
  readonly via: 'constructor' | 'inject';
  readonly optional: boolean;
}

/** `provides`: NgModule|Component|Route -> Service */
export type ProvidesEdge = EdgeBase<'provides'>;

/** `imports`: Component|NgModule -> Component|Directive|Pipe|NgModule */
export type ImportsEdge = EdgeBase<'imports'>;

/** `renders`: Component -> Template */
export type RendersEdge = EdgeBase<'renders'>;

/** `uses_in_template`: Template -> Component|Directive|Pipe (by resolved selector) */
export interface UsesInTemplateEdge extends EdgeBase<'uses_in_template'> {
  readonly selector: string;
}

export type BindingKind =
  | 'interpolation'
  | 'property'
  | 'event'
  | 'two-way'
  | 'control-flow'
  | 'attribute'
  | 'template-reference';

/** `binds`: Template -> Signal|Observable|Method|Property (member name + binding kind) */
export interface BindsEdge extends EdgeBase<'binds'> {
  readonly bindingKind: BindingKind;
  readonly memberName: string;
  /** Which kind of member `to` points at when no dedicated Signal/Observable node exists. */
  readonly targetKind: 'signal' | 'observable' | 'method' | 'property';
}

/** `emits`: Template -> Output */
export interface EmitsEdge extends EdgeBase<'emits'> {
  readonly outputName: string;
}

/** `routes_to`: Route -> Component */
export type RoutesToEdge = EdgeBase<'routes_to'>;

/** `child_of`: Route -> Route */
export type ChildOfEdge = EdgeBase<'child_of'>;

/** `guarded_by`: Route -> Guard */
export type GuardedByEdge = EdgeBase<'guarded_by'>;

/** `resolves_with`: Route -> Resolver */
export type ResolvesWithEdge = EdgeBase<'resolves_with'>;

/** `calls_http`: Service|Component -> HttpCall */
export type CallsHttpEdge = EdgeBase<'calls_http'>;

/** `intercepted_by`: HttpCall -> Interceptor (when global and detectable) */
export type InterceptedByEdge = EdgeBase<'intercepted_by'>;

/** `returns`: HttpCall -> Model */
export type ReturnsEdge = EdgeBase<'returns'>;

/** `tested_by`: Symbol -> Spec */
export type TestedByEdge = EdgeBase<'tested_by'>;

/** `extends`: Class -> Class */
export type ExtendsEdge = EdgeBase<'extends'>;

export type GraphEdge =
  | DeclaresEdge
  | InjectsEdge
  | ProvidesEdge
  | ImportsEdge
  | RendersEdge
  | UsesInTemplateEdge
  | BindsEdge
  | EmitsEdge
  | RoutesToEdge
  | ChildOfEdge
  | GuardedByEdge
  | ResolvesWithEdge
  | CallsHttpEdge
  | InterceptedByEdge
  | ReturnsEdge
  | TestedByEdge
  | ExtendsEdge;
