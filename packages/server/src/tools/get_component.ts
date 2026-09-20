/**
 * `angular_get_component` — docs/PLAN.md, section 6, Phase 1. The central
 * tool: full profile of a component (state, dependencies, template
 * bindings, consumers, routes that load it, reachable HTTP, specs).
 *
 * R13: `ref` must be a full "path#Name" id, or a bare name that resolves to
 * exactly one Component — an ambiguous bare name throws instead of guessing.
 * `depth` bounds the reachable-HTTP traversal (P6): this tool never walks
 * the whole graph.
 */

import { z } from 'zod';

import { formatFacts } from '../format/index.js';
import type { Fact } from '../format/index.js';
import type {
  ComponentNode,
  HttpCallNode,
  InjectsEdge,
  RouteNode,
  SignalNode,
  SpecNode,
  TemplateNode,
  UsesInTemplateEdge,
} from '../graph/model.js';

import { defineTool, READ_ONLY_ANNOTATIONS } from './internal/define.js';
import { confidenceFromUrlConfidence, makeFact } from './internal/facts.js';
import { resolveRef } from './internal/refs.js';
import { formattedResponseSchema, pagingInputShape, rootInputField } from './internal/schemas.js';

const DEFAULT_HTTP_DEPTH = 3;
const MAX_HTTP_DEPTH = 10;

const inputSchema = {
  root: rootInputField,
  ref: z
    .string()
    .min(1)
    .describe(
      'Full component ref ("path#ComponentName"), or a bare component name. A bare name that matches more than ' +
        'one indexed component throws instead of picking one (R13) — call angular_find_symbol to disambiguate.',
    ),
  depth: z
    .number()
    .int()
    .min(0)
    .max(MAX_HTTP_DEPTH)
    .optional()
    .describe(
      `How many "injects"/"calls_http" hops to follow when collecting HTTP calls reachable from this component. ` +
        `Defaults to ${DEFAULT_HTTP_DEPTH}. Bounded so the response never grows unbounded (docs/PLAN.md P6).`,
    ),
  ...pagingInputShape,
};

const outputSchema = {
  id: z.string(),
  name: z.string(),
  path: z.string(),
  selector: z.string().optional(),
  standalone: z.boolean(),
  changeDetection: z.enum(['Default', 'OnPush']),
  templatePath: z.string().optional(),
  inlineTemplate: z.boolean(),
  stylePaths: z.array(z.string()),
  depth: z.number().int(),
  result: formattedResponseSchema.describe(
    'Inputs, outputs, signals, lifecycle hooks, host bindings, dependencies, imports, template, consumers, ' +
      'loading routes, reachable HTTP calls and specs, all as one paginated/formatted list of facts. Facts derived ' +
      'from resolved import paths or lazy-route specifiers are "inferred", not "certain" (docs/PLAN.md risk R7).',
  ),
};

export const getComponentTool = defineTool({
  name: 'angular_get_component',
  description:
    'Full profile of one Angular component: template info, inputs/outputs/signals, lifecycle hooks, host bindings, ' +
    'injected dependencies, imports, who renders it in their template, which routes load it, HTTP calls reachable ' +
    'within "depth" hops, and its specs. Requires a full ref or an unambiguous bare name (docs/PLAN.md risk R13) — ' +
    'call angular_find_symbol first if you only know a partial name. Import/selector resolutions are marked ' +
    '"inferred" when they were not checked against disk; anything that could not be resolved is "unknown", never guessed.',
  inputSchema,
  outputSchema,
  annotations: { ...READ_ONLY_ANNOTATIONS, title: 'Get component' },
  async handler(input, context) {
    const root = context.resolveRoot(input.root);
    const graph = context.requireGraph(root);
    const component = resolveRef(graph, input.ref, 'Component') as ComponentNode;
    const depth = input.depth ?? DEFAULT_HTTP_DEPTH;

    const facts: Fact[] = [];

    for (const inputBinding of component.inputs) {
      const alias = inputBinding.alias ? ` (alias "${inputBinding.alias}")` : '';
      facts.push(
        makeFact({
          kind: 'Input',
          summary: `${inputBinding.name}${alias}: ${inputBinding.typeText ?? 'unknown type'}${inputBinding.required ? ' (required)' : ''}`,
          provenance: { file: component.path },
          confidence: inputBinding.typeText ? 'certain' : 'unknown',
          detail: { ...inputBinding },
        }),
      );
    }

    for (const outputBinding of component.outputs) {
      const alias = outputBinding.alias ? ` (alias "${outputBinding.alias}")` : '';
      facts.push(
        makeFact({
          kind: 'Output',
          summary: `${outputBinding.name}${alias}: ${outputBinding.typeText ?? 'unknown type'}`,
          provenance: { file: component.path },
          confidence: outputBinding.typeText ? 'certain' : 'unknown',
          detail: { ...outputBinding },
        }),
      );
    }

    for (const signalId of component.signals) {
      const signal = graph.getNode(signalId) as SignalNode | undefined;
      if (!signal) continue;
      facts.push(
        makeFact({
          kind: 'Signal',
          summary: `${signal.name}: ${signal.signalKind}${signal.typeText ? ` <${signal.typeText}>` : ''}${signal.required ? ' (required)' : ''}`,
          provenance: { file: signal.path },
          confidence: 'certain',
          detail: { id: signal.id, signalKind: signal.signalKind, typeText: signal.typeText, required: signal.required },
        }),
      );
    }

    if (component.lifecycleHooks.length > 0) {
      facts.push(
        makeFact({
          kind: 'LifecycleHooks',
          summary: component.lifecycleHooks.join(', '),
          provenance: { file: component.path },
          confidence: 'certain',
          detail: { hooks: component.lifecycleHooks },
        }),
      );
    }

    if (component.hostBindings.length > 0) {
      facts.push(
        makeFact({
          kind: 'HostBindings',
          summary: component.hostBindings.join(', '),
          provenance: { file: component.path },
          confidence: 'certain',
          detail: { hostBindings: component.hostBindings },
        }),
      );
    }

    for (const edge of graph.edgesFrom(component.id, 'injects') as InjectsEdge[]) {
      const target = graph.getNode(edge.to);
      facts.push(
        makeFact({
          kind: 'Dependency',
          summary: `injects ${target?.name ?? edge.to} via ${edge.via}${edge.optional ? ' (optional)' : ''}`,
          provenance: edge.provenance,
          confidence: edge.confidence,
          detail: { to: edge.to, via: edge.via, optional: edge.optional },
        }),
      );
    }

    for (const edge of graph.edgesFrom(component.id, 'imports')) {
      const target = graph.getNode(edge.to);
      facts.push(
        makeFact({
          kind: 'Import',
          summary: `imports ${target?.name ?? edge.to}`,
          provenance: edge.provenance,
          confidence: edge.confidence,
          detail: { to: edge.to },
        }),
      );
    }

    const rendersEdge = graph.edgesFrom(component.id, 'renders')[0];
    if (rendersEdge) {
      const template = graph.getNode(rendersEdge.to) as TemplateNode | undefined;
      if (template) {
        const parseErrorSuffix = template.parseErrors.length > 0 ? ` (${template.parseErrors.length} parse error(s))` : '';
        facts.push(
          makeFact({
            kind: 'Template',
            summary: `${template.inline ? 'inline template' : template.path}${parseErrorSuffix}`,
            provenance: { file: template.path },
            confidence: 'certain',
            detail: { id: template.id, inline: template.inline, parseErrors: template.parseErrors },
          }),
        );

        for (const usesEdge of graph.edgesFrom(template.id, 'uses_in_template') as UsesInTemplateEdge[]) {
          const used = graph.getNode(usesEdge.to);
          facts.push(
            makeFact({
              kind: 'TemplateUses',
              summary: `template uses <${usesEdge.selector}> → ${used?.name ?? usesEdge.to}`,
              provenance: usesEdge.provenance,
              confidence: usesEdge.confidence,
              detail: { selector: usesEdge.selector, to: usesEdge.to },
            }),
          );
        }
      }
    }

    for (const usedByEdge of graph.edgesTo(component.id, 'uses_in_template') as UsesInTemplateEdge[]) {
      const template = graph.getNode(usedByEdge.from) as TemplateNode | undefined;
      const owner = template ? graph.edgesTo(template.id, 'renders')[0] : undefined;
      const ownerComponent = owner ? graph.getNode(owner.from) : undefined;
      facts.push(
        makeFact({
          kind: 'UsedInTemplate',
          summary: `used as <${usedByEdge.selector}> in ${ownerComponent?.name ?? template?.path ?? usedByEdge.from}'s template`,
          provenance: usedByEdge.provenance,
          confidence: usedByEdge.confidence,
          detail: { selector: usedByEdge.selector, templateId: usedByEdge.from, ownerComponentId: ownerComponent?.id },
        }),
      );
    }

    for (const routeEdge of graph.edgesTo(component.id, 'routes_to')) {
      const route = graph.getNode(routeEdge.from) as RouteNode | undefined;
      facts.push(
        makeFact({
          kind: 'Route',
          summary: `route "${route?.routePath ?? '?'}" loads this component${route?.lazy ? ` (lazy: ${route.lazy.kind})` : ''}`,
          provenance: routeEdge.provenance,
          confidence: routeEdge.confidence,
          detail: { routeId: routeEdge.from, routePath: route?.routePath, lazy: route?.lazy },
        }),
      );
    }

    const reachable = graph.traverse(component.id, { direction: 'out', maxDepth: depth, edgeKinds: ['injects', 'calls_http'] });
    for (const node of reachable.nodes) {
      if (node.kind !== 'HttpCall') continue;
      const call = node as HttpCallNode;
      const callEdge = graph.edgesTo(call.id, 'calls_http')[0];
      facts.push(
        makeFact({
          kind: 'HttpCall',
          summary: `${call.method.toUpperCase()} ${call.urlPattern} (depth ${reachable.depthOf.get(call.id) ?? '?'})`,
          provenance: callEdge?.provenance ?? { file: call.path },
          confidence: confidenceFromUrlConfidence(call.urlConfidence),
          detail: { id: call.id, method: call.method, urlPattern: call.urlPattern, urlConfidence: call.urlConfidence, callerRef: call.callerRef },
        }),
      );
    }

    for (const edge of graph.edgesFrom(component.id, 'tested_by')) {
      const spec = graph.getNode(edge.to) as SpecNode | undefined;
      facts.push(
        makeFact({
          kind: 'Spec',
          summary: `tested by ${spec?.path ?? edge.to}${spec && spec.describes.length > 0 ? ` (${spec.describes.join(', ')})` : ''}`,
          provenance: edge.provenance,
          confidence: edge.confidence,
          detail: { specId: edge.to, describes: spec?.describes },
        }),
      );
    }

    return {
      id: component.id,
      name: component.name,
      path: component.path,
      selector: component.selector,
      standalone: component.standalone,
      changeDetection: component.changeDetection,
      templatePath: component.templatePath,
      inlineTemplate: component.inlineTemplate,
      stylePaths: [...component.stylePaths],
      depth,
      result: formatFacts(facts, {
        limit: input.limit,
        offset: input.offset,
        format: input.format,
        title: `Component profile: ${component.id}`,
      }),
    };
  },
});
