/**
 * ProjectGraph: typed in-memory graph with indexes by node kind, by name and by
 * file. See docs/PLAN.md, section 4.1.
 *
 * It is a passive structure: it does not index code itself (that is the
 * indexer's job), it only stores and queries what the extractors produced.
 */

import type { EdgeKind, GraphEdge, GraphNode, NodeId, NodeKind } from './model.js';
import { normalizeRelativePath } from './model.js';

export type TraversalDirection = 'out' | 'in' | 'both';

export interface TraversalOptions {
  /** Traversal direction. Defaults to `'both'`. */
  readonly direction?: TraversalDirection;
  /**
   * Maximum depth to explore from the starting node. 0 returns only the
   * starting node. Defaults to 5 — a traversal is always bounded (P6).
   */
  readonly maxDepth?: number;
  /** When given, only edges of these kinds are followed. */
  readonly edgeKinds?: readonly EdgeKind[];
}

export interface TraversalResult {
  /** Nodes reached, including the starting node, in discovery order. */
  readonly nodes: GraphNode[];
  /** Edges actually traversed. */
  readonly edges: GraphEdge[];
  /** The depth at which each node was reached. */
  readonly depthOf: ReadonlyMap<NodeId, number>;
}

const DEFAULT_MAX_DEPTH = 5;

function assertValidNodeId(id: NodeId): void {
  if (!id.includes('#')) {
    throw new Error(
      `Invalid NodeId: "${id}". A node identifier must be "path#symbol", never just the name.`,
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

  /** Adds or replaces a node. Idempotent: reindexing the same id updates it. */
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

  /** Adds an edge. Either endpoint may be resolved after the edge itself. */
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

  /** Index by node kind. */
  nodesByKind(kind: NodeKind): GraphNode[] {
    const ids = this.indexByKind.get(kind);
    if (!ids) return [];
    return this.resolveAll(ids);
  }

  /** Index by exact symbol name. */
  nodesByName(name: string): GraphNode[] {
    const ids = this.indexByName.get(name);
    if (!ids) return [];
    return this.resolveAll(ids);
  }

  /** Index by source file (normalized relative path). */
  nodesByFile(path: string): GraphNode[] {
    const ids = this.indexByFile.get(normalizeRelativePath(path));
    if (!ids) return [];
    return this.resolveAll(ids);
  }

  /** Outgoing edges of a node, optionally filtered by kind. */
  edgesFrom(id: NodeId, kind?: EdgeKind): GraphEdge[] {
    const list = this.edgesByFrom.get(id) ?? [];
    return kind ? list.filter((edge) => edge.kind === kind) : list.slice();
  }

  /** Incoming edges of a node, optionally filtered by kind. */
  edgesTo(id: NodeId, kind?: EdgeKind): GraphEdge[] {
    const list = this.edgesByTo.get(id) ?? [];
    return kind ? list.filter((edge) => edge.kind === kind) : list.slice();
  }

  /**
   * Removes every node and edge derived from a file. Used when reindexing
   * incrementally: before re-extracting a file, whatever was derived from its
   * previous version must be deleted (this avoids R2: a graph out of sync,
   * holding symbols that no longer exist).
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

  /** Removes a node and every edge that touches it. */
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
   * Traverses the graph from `startId` in the requested direction, with a depth
   * limit (P6: no tool ever returns the whole graph). BFS, cycle-safe.
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
