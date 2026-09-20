/**
 * ProjectGraph: grafo tipado en memoria con indices por tipo de nodo, por
 * nombre y por archivo. Ver docs/PLAN.md, seccion 4.1.
 *
 * Es una estructura pasiva: no indexa codigo por si misma (eso es trabajo
 * del indexer), solo almacena y consulta lo que los extractors produjeron.
 */

import type { EdgeKind, GraphEdge, GraphNode, NodeId, NodeKind } from './model.js';
import { normalizeRelativePath } from './model.js';

export type TraversalDirection = 'out' | 'in' | 'both';

export interface TraversalOptions {
  /** Sentido del recorrido. Por defecto `'both'`. */
  readonly direction?: TraversalDirection;
  /**
   * Profundidad maxima a explorar desde el nodo inicial. 0 devuelve solo el
   * nodo inicial. Por defecto 5 — un recorrido siempre esta acotado (P6).
   */
  readonly maxDepth?: number;
  /** Si se da, solo se siguen aristas de estos tipos. */
  readonly edgeKinds?: readonly EdgeKind[];
}

export interface TraversalResult {
  /** Nodos alcanzados, incluido el nodo inicial, en orden de descubrimiento. */
  readonly nodes: GraphNode[];
  /** Aristas efectivamente recorridas. */
  readonly edges: GraphEdge[];
  /** Profundidad a la que se alcanzo cada nodo. */
  readonly depthOf: ReadonlyMap<NodeId, number>;
}

const DEFAULT_MAX_DEPTH = 5;

function assertValidNodeId(id: NodeId): void {
  if (!id.includes('#')) {
    throw new Error(
      `NodeId invalido: "${id}". El identificador de nodo debe ser "ruta#simbolo", nunca solo el nombre.`,
    );
  }
}

export class ProjectGraph {
  private readonly nodesById = new Map<NodeId, GraphNode>();
  private readonly edges: GraphEdge[] = [];
  private readonly edgesByFrom = new Map<NodeId, GraphEdge[]>();
  private readonly edgesByTo = new Map<NodeId, GraphEdge[]>();

  private readonly indexByKind = new Map<NodeKind, Set<NodeId>>();
  private readonly indexByName = new Map<string, Set<NodeId>>();
  private readonly indexByFile = new Map<string, Set<NodeId>>();

  /** Agrega o reemplaza un nodo. Idempotente: reindexar el mismo id lo actualiza. */
  addNode(node: GraphNode): void {
    assertValidNodeId(node.id);

    const previous = this.nodesById.get(node.id);
    if (previous) {
      this.unindexNode(previous);
    }

    this.nodesById.set(node.id, node);
    this.indexNode(node);
  }

  addNodes(nodes: Iterable<GraphNode>): void {
    for (const node of nodes) this.addNode(node);
  }

  /** Agrega una arista. Ambos extremos pueden resolverse despues de la arista. */
  addEdge(edge: GraphEdge): void {
    this.edges.push(edge);
    this.pushIndexed(this.edgesByFrom, edge.from, edge);
    this.pushIndexed(this.edgesByTo, edge.to, edge);
  }

  addEdges(edges: Iterable<GraphEdge>): void {
    for (const edge of edges) this.addEdge(edge);
  }

  getNode(id: NodeId): GraphNode | undefined {
    return this.nodesById.get(id);
  }

  hasNode(id: NodeId): boolean {
    return this.nodesById.has(id);
  }

  allNodes(): readonly GraphNode[] {
    return Array.from(this.nodesById.values());
  }

  allEdges(): readonly GraphEdge[] {
    return this.edges.slice();
  }

  get nodeCount(): number {
    return this.nodesById.size;
  }

  get edgeCount(): number {
    return this.edges.length;
  }

  /** Indice por tipo de nodo. */
  nodesByKind(kind: NodeKind): GraphNode[] {
    const ids = this.indexByKind.get(kind);
    if (!ids) return [];
    return this.resolveAll(ids);
  }

  /** Indice por nombre exacto de simbolo. */
  nodesByName(name: string): GraphNode[] {
    const ids = this.indexByName.get(name);
    if (!ids) return [];
    return this.resolveAll(ids);
  }

  /** Indice por archivo de origen (ruta relativa normalizada). */
  nodesByFile(path: string): GraphNode[] {
    const ids = this.indexByFile.get(normalizeRelativePath(path));
    if (!ids) return [];
    return this.resolveAll(ids);
  }

  /** Aristas salientes de un nodo, opcionalmente filtradas por tipo. */
  edgesFrom(id: NodeId, kind?: EdgeKind): GraphEdge[] {
    const list = this.edgesByFrom.get(id) ?? [];
    return kind ? list.filter((edge) => edge.kind === kind) : list.slice();
  }

  /** Aristas entrantes de un nodo, opcionalmente filtradas por tipo. */
  edgesTo(id: NodeId, kind?: EdgeKind): GraphEdge[] {
    const list = this.edgesByTo.get(id) ?? [];
    return kind ? list.filter((edge) => edge.kind === kind) : list.slice();
  }

  /**
   * Elimina todos los nodos y aristas derivados de un archivo. Se usa al
   * reindexar incrementalmente: antes de volver a extraer un archivo hay que
   * borrar lo que se deriva de su version anterior (evita R2: grafo
   * desincronizado con simbolos que ya no existen).
   */
  removeFile(path: string): void {
    const normalized = normalizeRelativePath(path);
    const ids = this.indexByFile.get(normalized);
    if (!ids) return;

    for (const id of Array.from(ids)) {
      this.removeNode(id);
    }
    this.indexByFile.delete(normalized);
  }

  /** Elimina un nodo y toda arista que lo toque. */
  removeNode(id: NodeId): void {
    const node = this.nodesById.get(id);
    if (!node) return;

    this.unindexNode(node);
    this.nodesById.delete(id);

    const outgoing = this.edgesByFrom.get(id) ?? [];
    const incoming = this.edgesByTo.get(id) ?? [];
    const toRemove = new Set<GraphEdge>([...outgoing, ...incoming]);
    if (toRemove.size > 0) {
      this.removeEdges((edge) => toRemove.has(edge));
    }
    this.edgesByFrom.delete(id);
    this.edgesByTo.delete(id);
  }

  private removeEdges(predicate: (edge: GraphEdge) => boolean): void {
    for (let i = this.edges.length - 1; i >= 0; i -= 1) {
      if (predicate(this.edges[i]!)) this.edges.splice(i, 1);
    }
    for (const list of this.edgesByFrom.values()) {
      for (let i = list.length - 1; i >= 0; i -= 1) {
        if (predicate(list[i]!)) list.splice(i, 1);
      }
    }
    for (const list of this.edgesByTo.values()) {
      for (let i = list.length - 1; i >= 0; i -= 1) {
        if (predicate(list[i]!)) list.splice(i, 1);
      }
    }
  }

  clear(): void {
    this.nodesById.clear();
    this.edges.length = 0;
    this.edgesByFrom.clear();
    this.edgesByTo.clear();
    this.indexByKind.clear();
    this.indexByName.clear();
    this.indexByFile.clear();
  }

  /**
   * Recorre el grafo desde `startId` en el sentido pedido, con limite de
   * profundidad (P6: ninguna herramienta devuelve el grafo entero). BFS,
   * protegido contra ciclos.
   */
  traverse(startId: NodeId, options: TraversalOptions = {}): TraversalResult {
    const direction = options.direction ?? 'both';
    const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
    const edgeKinds = options.edgeKinds;

    const startNode = this.nodesById.get(startId);
    const depthOf = new Map<NodeId, number>();
    const nodes: GraphNode[] = [];
    const visitedEdges = new Set<GraphEdge>();
    const edgesOut: GraphEdge[] = [];

    if (!startNode) {
      return { nodes, edges: edgesOut, depthOf };
    }

    depthOf.set(startId, 0);
    nodes.push(startNode);

    let frontier: NodeId[] = [startId];
    let depth = 0;

    while (frontier.length > 0 && depth < maxDepth) {
      const nextFrontier: NodeId[] = [];

      for (const currentId of frontier) {
        const candidateEdges = this.neighborEdges(currentId, direction);
        for (const edge of candidateEdges) {
          if (edgeKinds && !edgeKinds.includes(edge.kind)) continue;

          const neighborId = edge.from === currentId ? edge.to : edge.from;
          const neighborNode = this.nodesById.get(neighborId);
          if (!neighborNode) continue;

          if (!visitedEdges.has(edge)) {
            visitedEdges.add(edge);
            edgesOut.push(edge);
          }

          if (depthOf.has(neighborId)) continue;

          depthOf.set(neighborId, depth + 1);
          nodes.push(neighborNode);
          nextFrontier.push(neighborId);
        }
      }

      frontier = nextFrontier;
      depth += 1;
    }

    return { nodes, edges: edgesOut, depthOf };
  }

  private neighborEdges(id: NodeId, direction: TraversalDirection): GraphEdge[] {
    if (direction === 'out') return this.edgesByFrom.get(id) ?? [];
    if (direction === 'in') return this.edgesByTo.get(id) ?? [];
    return [...(this.edgesByFrom.get(id) ?? []), ...(this.edgesByTo.get(id) ?? [])];
  }

  private indexNode(node: GraphNode): void {
    this.addToIndex(this.indexByKind, node.kind, node.id);
    this.addToIndex(this.indexByName, node.name, node.id);
    this.addToIndex(this.indexByFile, normalizeRelativePath(node.path), node.id);
  }

  private unindexNode(node: GraphNode): void {
    this.removeFromIndex(this.indexByKind, node.kind, node.id);
    this.removeFromIndex(this.indexByName, node.name, node.id);
    this.removeFromIndex(this.indexByFile, normalizeRelativePath(node.path), node.id);
  }

  private addToIndex<K>(index: Map<K, Set<NodeId>>, key: K, id: NodeId): void {
    let set = index.get(key);
    if (!set) {
      set = new Set();
      index.set(key, set);
    }
    set.add(id);
  }

  private removeFromIndex<K>(index: Map<K, Set<NodeId>>, key: K, id: NodeId): void {
    const set = index.get(key);
    if (!set) return;
    set.delete(id);
    if (set.size === 0) index.delete(key);
  }

  private pushIndexed(map: Map<NodeId, GraphEdge[]>, key: NodeId, edge: GraphEdge): void {
    let list = map.get(key);
    if (!list) {
      list = [];
      map.set(key, list);
    }
    list.push(edge);
  }

  private resolveAll(ids: Set<NodeId>): GraphNode[] {
    const result: GraphNode[] = [];
    for (const id of ids) {
      const node = this.nodesById.get(id);
      if (node) result.push(node);
    }
    return result;
  }
}

export * from './model.js';
