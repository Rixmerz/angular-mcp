/**
 * Tests for structural signatures and similarity ranking
 * (docs/PLAN.md, section 6, Phase 3).
 *
 * What is pinned here is that the comparison is *structural* — two components
 * that solve the same problem with different names must match, and two that
 * share names but not structure must not — and that the ranking is a total,
 * deterministic order, since P2 requires the output to be reproducible from
 * the graph.
 */

import { describe, expect, it } from 'vitest';

import { ProjectGraph } from '../../src/graph/index.js';
import type { ComponentNode, GraphEdge, ServiceNode, SignalNode } from '../../src/graph/model.js';
import { compareSignatures, describeDifference, findSimilar, signatureOf } from '../../src/patterns/signature.js';

function component(path: string, name: string, overrides: Partial<ComponentNode> = {}): ComponentNode {
  return {
    id: `${path}#${name}`,
    kind: 'Component',
    path,
    name,
    standalone: true,
    changeDetection: 'Default',
    inlineTemplate: false,
    stylePaths: [],
    inputs: [],
    outputs: [],
    signals: [],
    lifecycleHooks: [],
    hostBindings: [],
    ...overrides,
  };
}

function service(path: string, name: string): ServiceNode {
  return { id: `${path}#${name}`, kind: 'Service', path, name, providedIn: 'root', isInjectable: true };
}

function signal(ownerRef: string, name: string, signalKind: SignalNode['signalKind'], required = false): SignalNode {
  const [path] = ownerRef.split('#');
  return {
    id: `${ownerRef}.${name}`,
    kind: 'Signal',
    path: path ?? '',
    name,
    ownerRef,
    signalKind,
    required,
  };
}

function edge(kind: GraphEdge['kind'], from: string, to: string): GraphEdge {
  return { kind, from, to, provenance: { file: from.split('#')[0] ?? '' }, confidence: 'certain' } as GraphEdge;
}

/**
 * Two paginated lists that share no identifier names, plus one unrelated
 * component — the shape the tool has to be able to tell apart.
 */
function buildGraph(): ProjectGraph {
  const graph = new ProjectGraph();

  const orders = component('src/app/orders/order-list.component.ts', 'OrderListComponent');
  const invoices = component('src/app/invoices/invoice-table.component.ts', 'InvoiceTableComponent');
  const about = component('src/app/about/about.component.ts', 'AboutComponent');

  const orderService = service('src/app/core/order.service.ts', 'OrderService');
  const invoiceService = service('src/app/core/invoice.service.ts', 'InvoiceService');

  graph.addNodes([orders, invoices, about, orderService, invoiceService]);

  // Different names, same structure: required input, model, two signals, computed.
  graph.addNodes([
    signal(orders.id, 'pageSize', 'input', true),
    signal(orders.id, 'currentPage', 'model'),
    signal(orders.id, 'rows', 'signal'),
    signal(orders.id, 'total', 'signal'),
    signal(orders.id, 'pageCount', 'computed'),
  ]);
  graph.addNodes([
    signal(invoices.id, 'perPage', 'input', true),
    signal(invoices.id, 'page', 'model'),
    signal(invoices.id, 'items', 'signal'),
    signal(invoices.id, 'count', 'signal'),
    signal(invoices.id, 'lastPage', 'computed'),
  ]);
  // AboutComponent holds one plain signal and nothing else.
  graph.addNode(signal(about.id, 'status', 'signal'));

  graph.addEdges([
    edge('injects', orders.id, orderService.id),
    edge('injects', invoices.id, invoiceService.id),
  ]);

  // Both services fetch a page over HTTP.
  const orderCall = {
    id: 'src/app/core/order.service.ts#OrderService.getOrders.get',
    kind: 'HttpCall' as const,
    path: 'src/app/core/order.service.ts',
    name: 'getOrders',
    method: 'get' as const,
    urlPattern: '/api/orders',
    urlConfidence: 'literal' as const,
    callerRef: orderService.id,
  };
  const invoiceCall = { ...orderCall, id: 'src/app/core/invoice.service.ts#InvoiceService.getInvoices.get', path: 'src/app/core/invoice.service.ts', name: 'getInvoices', urlPattern: '/api/invoices', callerRef: invoiceService.id };
  graph.addNodes([orderCall, invoiceCall]);
  graph.addEdges([
    edge('calls_http', orderService.id, orderCall.id),
    edge('calls_http', invoiceService.id, invoiceCall.id),
  ]);

  return graph;
}

describe('signatureOf', () => {
  it('describes state by primitive kind, not by member name', () => {
    const graph = buildGraph();
    const orders = graph.getNode('src/app/orders/order-list.component.ts#OrderListComponent');

    const signature = signatureOf(graph, orders!);

    expect(signature.tokens.state).toEqual(['state:computed', 'state:input:required', 'state:model', 'state:signal']);
    // Not a single identifier from the source leaks into the signature.
    expect(signature.tokens.state.join(' ')).not.toContain('pageSize');
  });

  it('reaches HTTP through one hop of injection, so a component matches the service that fetches for it', () => {
    const graph = buildGraph();
    const orders = graph.getNode('src/app/orders/order-list.component.ts#OrderListComponent');

    expect(signatureOf(graph, orders!).tokens.http).toEqual(['http:get:indirect']);
  });
});

describe('findSimilar', () => {
  it('ranks the structurally identical component first, despite sharing no names', () => {
    const graph = buildGraph();
    const orders = graph.getNode('src/app/orders/order-list.component.ts#OrderListComponent');

    const [best, ...rest] = findSimilar(graph, orders!);

    expect(best?.signature.name).toBe('InvoiceTableComponent');
    // Not a perfect score, and correctly so: they inject *a* service each, but
    // not the same one, and reporting that difference is the point.
    expect(best?.score).toBeGreaterThan(0.7);
    expect(rest[0]?.signature.name).toBe('AboutComponent');
    expect(rest[0]?.score).toBeLessThan(best!.score);
  });

  it('never returns the target itself, and only compares nodes of the same kind', () => {
    const graph = buildGraph();
    const orders = graph.getNode('src/app/orders/order-list.component.ts#OrderListComponent');

    const results = findSimilar(graph, orders!);

    expect(results.map((result) => result.signature.ref)).not.toContain(orders!.id);
    expect(results.every((result) => result.signature.kind === 'Component')).toBe(true);
  });

  it('restricts the comparison to the requested aspects', () => {
    const graph = buildGraph();
    const orders = graph.getNode('src/app/orders/order-list.component.ts#OrderListComponent');

    const results = findSimilar(graph, orders!, ['state']);

    expect(results[0]?.byAspect.map((aspect) => aspect.aspect)).toEqual(['state']);
    // AboutComponent shares only `state:signal` out of five distinct tokens.
    const about = results.find((result) => result.signature.name === 'AboutComponent');
    expect(about?.score).toBeCloseTo(1 / 4, 5);
  });

  it('orders ties by ref, so repeated runs agree (P2)', () => {
    const graph = buildGraph();
    const orders = graph.getNode('src/app/orders/order-list.component.ts#OrderListComponent');

    const first = findSimilar(graph, orders!).map((result) => result.signature.ref);
    const second = findSimilar(graph, orders!).map((result) => result.signature.ref);

    expect(first).toEqual(second);
  });
});

describe('describeDifference', () => {
  it('states the difference in both directions without ranking either side', () => {
    const graph = buildGraph();
    const orders = signatureOf(graph, graph.getNode('src/app/orders/order-list.component.ts#OrderListComponent')!);
    const about = signatureOf(graph, graph.getNode('src/app/about/about.component.ts#AboutComponent')!);

    const description = describeDifference(compareSignatures(orders, about));

    expect(description).toContain('lacks');
    expect(description).toMatch(/state:computed|state:model|state:input:required/);
    // No evaluative language: it says what differs, not what is better.
    expect(description).not.toMatch(/better|worse|should|prefer/i);
  });

  it('says so plainly when two symbols are identical over the compared aspects', () => {
    const graph = buildGraph();
    const orders = signatureOf(graph, graph.getNode('src/app/orders/order-list.component.ts#OrderListComponent')!);
    const invoices = signatureOf(graph, graph.getNode('src/app/invoices/invoice-table.component.ts#InvoiceTableComponent')!);

    // Their state and HTTP shapes match exactly; only the injected service's
    // name differs, which the `dependencies` aspect is there to surface.
    expect(describeDifference(compareSignatures(orders, invoices, ['state', 'http']))).toBe(
      'identical structure over the compared aspects',
    );
    expect(describeDifference(compareSignatures(orders, invoices, ['dependencies']))).toContain('InvoiceService');
  });
});
