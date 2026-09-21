/**
 * Structural signatures. See docs/PLAN.md, section 6, Phase 3
 * (`angular_find_similar`) and section 12 (`src/patterns/`).
 *
 * A signature is what a symbol *does* structurally, reduced to a set of
 * tokens: which dependencies it injects, which reactive primitives it
 * declares, which HTTP methods it reaches, what its template is made of. Two
 * symbols are similar when their token sets overlap.
 *
 * Everything here is derived from the graph, so the same graph always gives
 * the same answer (P2). Similarity is a counted ratio, not a judgement: the
 * tool reports which tokens matched and which did not, and the caller decides
 * whether that is "similar enough" for what it is doing.
 */

import type { ProjectGraph } from '../graph/index.js';
import type { ComponentNode, GraphNode, NodeId, SignalNode, HttpCallNode } from '../graph/model.js';

/** The facets a signature can be compared on (docs/PLAN.md section 6, `aspect`). */
export const SIGNATURE_ASPECTS = ['dependencies', 'state', 'http', 'template'] as const;
export type SignatureAspect = (typeof SIGNATURE_ASPECTS)[number];

/** One symbol's structural tokens, grouped by aspect. */
export interface Signature {
  readonly ref: NodeId;
  readonly kind: string;
  readonly name: string;
  readonly tokens: Readonly<Record<SignatureAspect, readonly string[]>>;
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

/**
 * What a symbol injects, as two tokens per dependency: the injected symbol's
 * name, and its kind.
 *
 * Both are needed, for two different questions. "What else injects
 * HttpClient" needs the name. "What else has this shape" needs the kind,
 * because a paginated order list and a paginated invoice list are the same
 * pattern precisely because each injects *a* service, not the same one. The
 * name token still separates them, so a same-service match always outranks a
 * same-shape one.
 */
function dependencyTokens(graph: ProjectGraph, node: GraphNode): string[] {
  const tokens: string[] = [];

  for (const edge of graph.edgesFrom(node.id, 'injects')) {
    const target = graph.getNode(edge.to);
    // An unresolved injection still says something structural ("it injects
    // something"), so it is kept, addressed by the ref's symbol half.
    tokens.push(`injects:${target?.name ?? edge.to.split('#')[1] ?? edge.to}`);
    tokens.push(`injects-kind:${target?.kind ?? 'unknown'}`);
  }

  return uniqueSorted(tokens);
}

/**
 * Which reactive primitives a symbol declares, by kind — `signal`, `computed`,
 * `input`, `model`, `viewChild` and so on. The *names* are deliberately left
 * out: two paginated lists are the same shape whether they call it `pageSize`
 * or `perPage`.
 */
function stateTokens(graph: ProjectGraph, node: GraphNode): string[] {
  const tokens: string[] = [];

  for (const signal of graph.nodesByKind('Signal')) {
    const signalNode = signal as SignalNode;
    if (signalNode.ownerRef !== node.id) continue;
    tokens.push(`state:${signalNode.signalKind}${signalNode.required ? ':required' : ''}`);
  }

  for (const observable of graph.nodesByKind('Observable')) {
    if ((observable as { ownerRef?: NodeId }).ownerRef !== node.id) continue;
    tokens.push('state:observable');
  }

  return uniqueSorted(tokens);
}

/**
 * The HTTP a symbol reaches, by method — directly, or through one hop of
 * injection, because a component that gets its data from a service is doing
 * the same thing as one that calls `HttpClient` itself.
 */
function httpTokens(graph: ProjectGraph, node: GraphNode): string[] {
  const tokens: string[] = [];

  const addCallsOf = (ownerId: NodeId, viaInjection: boolean): void => {
    for (const edge of graph.edgesFrom(ownerId, 'calls_http')) {
      const call = graph.getNode(edge.to) as HttpCallNode | undefined;
      if (!call) continue;
      tokens.push(`http:${call.method.toLowerCase()}${viaInjection ? ':indirect' : ''}`);
    }
  };

  addCallsOf(node.id, false);
  for (const injected of graph.edgesFrom(node.id, 'injects')) {
    addCallsOf(injected.to, true);
  }

  return uniqueSorted(tokens);
}

/**
 * What a component's template is made of: the control-flow forms it uses and
 * the kinds of binding it declares. Reduced to shapes, never to the bound
 * expressions themselves.
 */
function templateTokens(graph: ProjectGraph, node: GraphNode): string[] {
  const tokens: string[] = [];

  for (const rendered of graph.edgesFrom(node.id, 'renders')) {
    for (const binding of graph.edgesFrom(rendered.to, 'binds')) {
      const bindingKind = (binding as { bindingKind?: string }).bindingKind;
      if (bindingKind) tokens.push(`binding:${bindingKind}`);
    }
    for (const used of graph.edgesFrom(rendered.to, 'uses_in_template')) {
      const target = graph.getNode(used.to);
      if (target) tokens.push(`uses:${target.kind}`);
    }
  }

  const component = node as ComponentNode;
  if (component.kind === 'Component') {
    tokens.push(component.inlineTemplate ? 'template:inline' : 'template:file');
    for (const input of component.inputs) tokens.push(`input:${input.isSignal ? 'signal' : 'decorator'}`);
    for (const output of component.outputs) tokens.push(`output:${output.isSignal ? 'signal' : 'decorator'}`);
  }

  return uniqueSorted(tokens);
}

/** Builds the full signature of one node. */
export function signatureOf(graph: ProjectGraph, node: GraphNode): Signature {
  return {
    ref: node.id,
    kind: node.kind,
    name: node.name,
    tokens: {
      dependencies: dependencyTokens(graph, node),
      state: stateTokens(graph, node),
      http: httpTokens(graph, node),
      template: templateTokens(graph, node),
    },
  };
}

export interface AspectComparison {
  readonly aspect: SignatureAspect;
  readonly shared: readonly string[];
  readonly onlyInTarget: readonly string[];
  readonly onlyInCandidate: readonly string[];
  /** Jaccard: shared / union. 1 when both sides are empty — two symbols with no state both have "no state". */
  readonly score: number;
}

export interface SimilarityResult {
  readonly signature: Signature;
  /** Mean of the compared aspects' scores. */
  readonly score: number;
  readonly byAspect: readonly AspectComparison[];
}

function compareAspect(
  aspect: SignatureAspect,
  target: readonly string[],
  candidate: readonly string[],
): AspectComparison {
  const targetSet = new Set(target);
  const candidateSet = new Set(candidate);

  const shared = target.filter((token) => candidateSet.has(token));
  const onlyInTarget = target.filter((token) => !candidateSet.has(token));
  const onlyInCandidate = candidate.filter((token) => !targetSet.has(token));

  const unionSize = new Set([...target, ...candidate]).size;

  return {
    aspect,
    shared,
    onlyInTarget,
    onlyInCandidate,
    score: unionSize === 0 ? 1 : shared.length / unionSize,
  };
}

/**
 * Compares two signatures over `aspects` (all four by default) and returns the
 * per-aspect overlap plus their mean.
 */
export function compareSignatures(
  target: Signature,
  candidate: Signature,
  aspects: readonly SignatureAspect[] = SIGNATURE_ASPECTS,
): SimilarityResult {
  const byAspect = aspects.map((aspect) =>
    compareAspect(aspect, target.tokens[aspect], candidate.tokens[aspect]),
  );

  const score = byAspect.length === 0 ? 0 : byAspect.reduce((sum, item) => sum + item.score, 0) / byAspect.length;

  return { signature: candidate, score, byAspect };
}

/**
 * A one-line, deterministic description of how a candidate differs from the
 * target: what it has that the target does not, and the other way round. It
 * states the difference; it never says which one is better.
 */
export function describeDifference(result: SimilarityResult): string {
  const extra = result.byAspect.flatMap((aspect) => aspect.onlyInCandidate);
  const missing = result.byAspect.flatMap((aspect) => aspect.onlyInTarget);

  if (extra.length === 0 && missing.length === 0) return 'identical structure over the compared aspects';

  const parts: string[] = [];
  if (extra.length > 0) parts.push(`also has ${extra.join(', ')}`);
  if (missing.length > 0) parts.push(`lacks ${missing.join(', ')}`);
  return parts.join('; ');
}

/**
 * Ranks every node of the same kind as `target` by similarity to it.
 *
 * The order is total and deterministic: score descending, then ref
 * ascending, so two candidates that tie never swap places between runs (P2).
 */
export function findSimilar(
  graph: ProjectGraph,
  target: GraphNode,
  aspects: readonly SignatureAspect[] = SIGNATURE_ASPECTS,
): SimilarityResult[] {
  const targetSignature = signatureOf(graph, target);

  return graph
    .nodesByKind(target.kind)
    .filter((node) => node.id !== target.id)
    .map((node) => compareSignatures(targetSignature, signatureOf(graph, node), aspects))
    .sort((a, b) => b.score - a.score || a.signature.ref.localeCompare(b.signature.ref));
}
