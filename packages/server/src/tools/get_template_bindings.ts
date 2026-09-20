/**
 * `angular_get_template_bindings` — docs/PLAN.md, section 6, Phase 1.
 *
 * Classified bindings of a component's template: interpolation, property,
 * event, two-way, control-flow and attribute bindings, plus the elements/
 * directives/pipes the template resolves to. `ref` names the *component*
 * (same R13 contract as `angular_get_component`); its template is found via
 * the `renders` edge.
 */

import { z } from 'zod';

import { formatFacts } from '../format/index.js';
import type { Fact } from '../format/index.js';
import type { BindsEdge, ComponentNode, SignalNode, TemplateNode, UsesInTemplateEdge } from '../graph/model.js';
import type { ProjectGraph } from '../graph/index.js';

import { defineTool, READ_ONLY_ANNOTATIONS } from './internal/define.js';
import { InvalidInputError } from './internal/errors.js';
import { makeFact } from './internal/facts.js';
import { resolveRef } from './internal/refs.js';
import { formattedResponseSchema, pagingInputShape, rootInputField } from './internal/schemas.js';

const inputSchema = {
  root: rootInputField,
  ref: z
    .string()
    .min(1)
    .describe(
      'Full component ref ("path#ComponentName"), or a bare component name. A bare name that matches more than ' +
        'one indexed component throws instead of picking one (R13) — call angular_find_symbol to disambiguate.',
    ),
  ...pagingInputShape,
};

const outputSchema = {
  componentRef: z.string(),
  templatePath: z.string(),
  inline: z.boolean(),
  parseErrorCount: z.number().int(),
  result: formattedResponseSchema.describe(
    'One fact per binding (interpolation/property/event/two-way/control-flow/attribute) and per resolved ' +
      'element/directive/pipe. A binding\'s member is resolved to a Signal/Observable when the component declares ' +
      'one of that exact name; otherwise its type is "unknown" — never guessed (docs/PLAN.md risk R7).',
  ),
};

function resolveMember(
  graph: ProjectGraph,
  component: ComponentNode,
  memberName: string,
): { resolvedKind?: 'signal'; typeText?: string } {
  for (const signalId of component.signals) {
    const signal = graph.getNode(signalId) as SignalNode | undefined;
    if (signal?.name === memberName) return { resolvedKind: 'signal', typeText: signal.typeText };
  }
  return {};
}

export const getTemplateBindingsTool = defineTool({
  name: 'angular_get_template_bindings',
  description:
    "Classifies a component's template bindings (interpolation, property, event, two-way, control-flow, " +
    'attribute) and the elements/directives/pipes it resolves to. Requires a full component ref or an unambiguous ' +
    'bare name (docs/PLAN.md risk R13). A binding\'s member is resolved to its declared Signal, when one of that ' +
    'exact name exists on the component (certain); otherwise its type is reported as unknown, never guessed (R7). ' +
    'Element/directive/pipe resolution confidence is exactly the extractor\'s own (certain/inferred/unknown).',
  inputSchema,
  outputSchema,
  annotations: { ...READ_ONLY_ANNOTATIONS, title: 'Get template bindings' },
  async handler(input, context) {
    const root = context.resolveRoot(input.root);
    const graph = context.requireGraph(root);
    const component = resolveRef(graph, input.ref, 'Component') as ComponentNode;

    const rendersEdge = graph.edgesFrom(component.id, 'renders')[0];
    if (!rendersEdge) {
      throw new InvalidInputError(
        `Component "${component.id}" has no indexed template (no inline template source, or its templateUrl ` +
          'could not be resolved/read). Re-run angular_index_project after fixing the template reference.',
      );
    }
    const template = graph.getNode(rendersEdge.to) as TemplateNode;

    const facts: Fact[] = [];

    for (const error of template.parseErrors) {
      facts.push(
        makeFact({
          kind: 'ParseError',
          summary: error.message,
          provenance: { file: template.path, line: error.line, column: error.column },
          confidence: 'certain',
          detail: { ...error },
        }),
      );
    }

    for (const edge of graph.edgesFrom(template.id, 'binds') as BindsEdge[]) {
      const resolved = resolveMember(graph, component, edge.memberName);
      const resolvedKind = resolved.resolvedKind ?? edge.targetKind;
      const typeSuffix = resolved.typeText ? `: ${resolved.typeText}` : '';
      facts.push(
        makeFact({
          kind: edge.bindingKind,
          summary: `${edge.bindingKind} binding to \`${edge.memberName}\` (${resolvedKind}${typeSuffix})`,
          provenance: edge.provenance,
          confidence: edge.confidence,
          detail: {
            memberName: edge.memberName,
            bindingKind: edge.bindingKind,
            targetKind: edge.targetKind,
            resolved: resolved.resolvedKind !== undefined,
            resolvedTypeText: resolved.typeText,
          },
        }),
      );
    }

    for (const edge of graph.edgesFrom(template.id, 'uses_in_template') as UsesInTemplateEdge[]) {
      const target = graph.getNode(edge.to);
      facts.push(
        makeFact({
          kind: 'UsesInTemplate',
          summary: `<${edge.selector}> resolves to ${target?.name ?? edge.to} (${target?.kind ?? 'unresolved'})`,
          provenance: edge.provenance,
          confidence: edge.confidence,
          detail: { selector: edge.selector, to: edge.to, resolvedKind: target?.kind },
        }),
      );
    }

    return {
      componentRef: component.id,
      templatePath: template.path,
      inline: template.inline,
      parseErrorCount: template.parseErrors.length,
      result: formatFacts(facts, {
        limit: input.limit,
        offset: input.offset,
        format: input.format,
        title: `Template bindings: ${component.id}`,
      }),
    };
  },
});
