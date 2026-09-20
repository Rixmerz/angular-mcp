/**
 * Modelo de datos del grafo del proyecto. Ver docs/PLAN.md, seccion 5.
 *
 * Contrato para los extractors (packages/server/src/indexer/extractors/*):
 * cada extractor produce GraphNode[] y GraphEdge[] a partir de un
 * ts.SourceFile (o un template), sin efectos secundarios.
 *
 * Principio P1 del plan: nada que no se pueda rederivar del codigo se
 * persiste como verdad. Estos tipos describen hechos derivados, nunca
 * estado editable a mano.
 */

// ---------------------------------------------------------------------------
// Identidad
// ---------------------------------------------------------------------------

/**
 * Identificador unico de un nodo: `ruta/relativa/al/archivo.ts#NombreSimbolo`.
 * Nunca solo el nombre (R13: varios `UserListComponent` en un monorepo es un
 * caso real). La ruta es siempre relativa a la raiz del proyecto analizado,
 * con separadores `/`.
 */
export type NodeId = string;

/** Construye un NodeId a partir de una ruta relativa y un simbolo. */
export function makeNodeId(relativePath: string, symbol: string): NodeId {
  const normalized = normalizeRelativePath(relativePath);
  if (symbol.length === 0) {
    throw new Error(`makeNodeId: symbol vacio para "${normalized}"`);
  }
  return `${normalized}#${symbol}`;
}

/** Separa un NodeId en su ruta de archivo y su simbolo. */
export function parseNodeId(id: NodeId): { path: string; symbol: string } {
  const hashIndex = id.indexOf('#');
  if (hashIndex === -1) {
    throw new Error(`NodeId invalido, falta "#ruta#simbolo": "${id}"`);
  }
  return { path: id.slice(0, hashIndex), symbol: id.slice(hashIndex + 1) };
}

/** Normaliza separadores de path a `/` y quita un `./` inicial. */
export function normalizeRelativePath(relativePath: string): string {
  const withForwardSlashes = relativePath.replace(/\\/g, '/');
  return withForwardSlashes.startsWith('./') ? withForwardSlashes.slice(2) : withForwardSlashes;
}

// ---------------------------------------------------------------------------
// Proveniencia y confianza (P4, R7)
// ---------------------------------------------------------------------------

/** De donde salio un hecho: archivo, linea y columna, 1-based. */
export interface Provenance {
  readonly file: string;
  readonly line: number;
  readonly column: number;
}

/**
 * Nivel de confianza de un hecho. Nunca se adivina: lo no resoluble es
 * `unknown`, nunca un valor inventado (R3, R7).
 */
export type Confidence = 'certain' | 'inferred' | 'unknown';

// ---------------------------------------------------------------------------
// Nodos — tabla 5.1
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
  /** Ruta relativa del archivo del que se derivo el nodo. */
  readonly path: string;
  /** Nombre del simbolo (o nombre sintetico para nodos sin simbolo TS). */
  readonly name: string;
}

export type ChangeDetectionStrategy = 'Default' | 'OnPush';

export interface InputBinding {
  readonly name: string;
  readonly alias?: string;
  readonly typeText?: string;
  readonly required: boolean;
  /** true si se declaro con la funcion `input()`/`input.required()`, false si es `@Input()`. */
  readonly isSignal: boolean;
}

export interface OutputBinding {
  readonly name: string;
  readonly alias?: string;
  readonly typeText?: string;
  /** true si se declaro con la funcion `output()`, false si es `@Output()`. */
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
  /** NodeId de los nodos Signal declarados por este componente. */
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
  /** Especificadores tal como aparecen en el decorador; la verdad de grafo son las aristas. */
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
 * Clase generica no cubierta por otro tipo de nodo (por ejemplo una clase
 * base abstracta sin decorador). Existe para que la arista `extends` siempre
 * tenga un nodo destino, incluso cuando la clase no es un concepto Angular.
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

/** Nodos que representan un simbolo declarado (para la arista `tested_by`). */
export type SymbolNode = Exclude<GraphNode, FileNode | TemplateNode | RouteNode | HttpCallNode>;

// ---------------------------------------------------------------------------
// Aristas — tabla 5.2
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

/** `injects`: Component|Directive|Service|Guard -> Service (constructor o inject()) */
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

/** `uses_in_template`: Template -> Component|Directive|Pipe (por selector resuelto) */
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

/** `binds`: Template -> Signal|Observable|Method|Property (nombre + tipo de binding) */
export interface BindsEdge extends EdgeBase<'binds'> {
  readonly bindingKind: BindingKind;
  readonly memberName: string;
  /** A que clase de miembro apunta `to` cuando no existe un nodo Signal/Observable dedicado. */
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

/** `intercepted_by`: HttpCall -> Interceptor (si es global y detectable) */
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
