/**
 * Registry of every Phase 1 tool (docs/PLAN.md, section 6). A future
 * `server.ts` registers each of these with the MCP SDK
 * (`registerTool(tool.name, { inputSchema: tool.inputSchema, outputSchema:
 * tool.outputSchema, annotations: tool.annotations }, cb)`); tests use
 * `tool.run(input, context)` directly.
 */

export { ToolContext } from './internal/context.js';
export type { IndexedState, ToolContextOptions } from './internal/context.js';
export { READ_ONLY_ANNOTATIONS, defineTool } from './internal/define.js';
export type { ToolAnnotations, ToolDefinition } from './internal/define.js';
export { AmbiguousRefError, InvalidInputError, NotIndexedError, RefNotFoundError, ToolError } from './internal/errors.js';
export type { RefCandidate } from './internal/errors.js';

export { assertInsideRoot, assertProjectRoot, isInsideRoot, validatePathInputs } from './internal/paths.js';
export { PHASE_2_TOOLS, checkRulesTool, explainLayerTool, listRulesTool } from './rules_tools.js';

export { indexProjectTool } from './index_project.js';
export { getIndexStatusTool } from './get_index_status.js';
export { findSymbolTool } from './find_symbol.js';
export { getComponentTool } from './get_component.js';
export { getServiceTool } from './get_service.js';
export { getRouteTreeTool } from './get_route_tree.js';
export { whoUsesTool } from './who_uses.js';
export { getTemplateBindingsTool } from './get_template_bindings.js';
export { listHttpCallsTool } from './list_http_calls.js';
export { impactOfTool } from './impact_of.js';
export { findSimilarTool } from './find_similar.js';
export { getApiContractTool } from './get_api_contract.js';
export { listDecisionsTool } from './list_decisions.js';

import { findSymbolTool } from './find_symbol.js';
import { getComponentTool } from './get_component.js';
import { getIndexStatusTool } from './get_index_status.js';
import { getRouteTreeTool } from './get_route_tree.js';
import { getServiceTool } from './get_service.js';
import { getTemplateBindingsTool } from './get_template_bindings.js';
import { findSimilarTool } from './find_similar.js';
import { getApiContractTool } from './get_api_contract.js';
import { impactOfTool } from './impact_of.js';
import { listDecisionsTool } from './list_decisions.js';
import { indexProjectTool } from './index_project.js';
import { listHttpCallsTool } from './list_http_calls.js';
import { whoUsesTool } from './who_uses.js';

/** Every Phase 1 tool, in the order they appear in docs/PLAN.md section 6. */
export const PHASE_1_TOOLS = [
  indexProjectTool,
  getIndexStatusTool,
  findSymbolTool,
  getComponentTool,
  getServiceTool,
  getRouteTreeTool,
  whoUsesTool,
  getTemplateBindingsTool,
  listHttpCallsTool,
  impactOfTool,
] as const;

/** The Phase 3 pattern and contract tools (docs/PLAN.md section 6). */
export const PHASE_3_TOOLS = [findSimilarTool, getApiContractTool, listDecisionsTool] as const;
