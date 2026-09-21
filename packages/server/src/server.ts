/**
 * The MCP server: a thin registration layer over the tools, resources and
 * prompt (docs/PLAN.md, section 4.1 — "registers tools with Zod, annotations
 * and output schemas. No domain logic").
 *
 * Everything this file decides is protocol-shaped: how a tool's result
 * becomes MCP content, how an error becomes an actionable message instead of
 * a stack trace, and where the R11 path check runs. The facts themselves
 * come from `src/tools/` and `src/rules/`, unchanged.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { PLAN_CHANGE_PROMPT_NAME, renderPlanChangePrompt } from './prompts/index.js';
import { PROJECT_SUMMARY_URI, RULES_URI, readProjectSummary, readRules } from './resources/index.js';
import { PHASE_1_TOOLS, PHASE_3_TOOLS, ToolContext, ToolError } from './tools/index.js';
import { PHASE_5_TOOLS } from './tools/mutations.js';
import { validatePathInputs } from './tools/internal/paths.js';
import { PHASE_2_TOOLS } from './tools/rules_tools.js';

export const SERVER_NAME = 'angular-mcp-server';
export const SERVER_VERSION = '0.0.1';

/**
 * Every tool this server exposes, in plan order: query, rules, patterns and
 * contracts, then the bounded mutations. The Phase 5 tools are the only ones
 * that can write, and each defaults to a dry run.
 */
export const ALL_TOOLS = [...PHASE_1_TOOLS, ...PHASE_2_TOOLS, ...PHASE_3_TOOLS, ...PHASE_5_TOOLS];

export interface CreateServerOptions {
  /** Root of the Angular workspace this server analyzes. Fixed for the server's lifetime (R11). */
  readonly projectRoot: string;
  /** Cache directory passed through to the indexer. */
  readonly cacheDir?: string;
}

/**
 * Turns a thrown error into a tool result rather than a protocol error, as
 * the MCP guidance prescribes. A `ToolError` is already written for the
 * caller ("what failed and what to try next"), so its message is passed
 * through; anything else is reported without leaking internals.
 */
function toErrorResult(error: unknown): { isError: true; content: { type: 'text'; text: string }[] } {
  const message =
    error instanceof ToolError
      ? error.message
      : `The tool failed: ${error instanceof Error ? error.message : String(error)}`;

  return { isError: true, content: [{ type: 'text', text: message }] };
}

/**
 * MCP wants both a human-readable rendering and, when the tool declares an
 * `outputSchema`, the structured object. Both come from the same value, so
 * they can never disagree.
 */
function toToolResult(output: Record<string, unknown>): {
  content: { type: 'text'; text: string }[];
  structuredContent: Record<string, unknown>;
} {
  const result = output['result'] as { format?: unknown; text?: unknown } | undefined;
  const text =
    result && typeof result === 'object' && result.format === 'markdown' && typeof result.text === 'string'
      ? result.text
      : JSON.stringify(output, null, 2);

  return { content: [{ type: 'text', text }], structuredContent: output };
}

export function createServer(options: CreateServerOptions): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const context = new ToolContext({ defaultRoot: options.projectRoot, cacheDir: options.cacheDir });

  for (const tool of ALL_TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.annotations.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        annotations: tool.annotations,
      },
      // The SDK infers a per-tool callback type from each Zod shape; ALL_TOOLS is
      // heterogeneous, so the shared handler is cast once, here at the boundary.
      (async (rawInput: unknown) => {
        try {
          // R11: one choke point for every path-bearing input, so a tool
          // added later cannot skip the check by forgetting to call it.
          validatePathInputs(options.projectRoot, rawInput);
          const output = await tool.run(rawInput, context);
          return toToolResult(output as Record<string, unknown>);
        } catch (error) {
          return toErrorResult(error);
        }
      }) as never,
    );
  }

  server.registerResource(
    'project-summary',
    PROJECT_SUMMARY_URI,
    {
      title: 'Project summary',
      description: 'Counts, versions, workspace layout and index coverage for the analyzed Angular project.',
      mimeType: 'application/json',
    },
    () => ({ contents: [readProjectSummary(context)] }),
  );

  server.registerResource(
    'rules',
    RULES_URI,
    {
      title: 'Architecture rules',
      description: 'The effective architecture rules, including which layers were imported from sheriff or Nx.',
      mimeType: 'application/json',
    },
    async () => ({ contents: [await readRules(context)] }),
  );

  server.registerPrompt(
    PLAN_CHANGE_PROMPT_NAME,
    {
      title: 'Plan a change',
      description:
        'Guides the sequence of tool calls to make before proposing a change: find_symbol, get_component, ' +
        'impact_of, find a pattern to follow, then check_rules.',
      argsSchema: {
        request: z.string().describe('What the user wants to change, in their own words.'),
        startingPoint: z.string().optional().describe('A symbol name or file path to start from, if one is known.'),
      },
    },
    (args) => ({
      messages: [
        {
          role: 'user' as const,
          content: { type: 'text' as const, text: renderPlanChangePrompt(args) },
        },
      ],
    }),
  );

  return server;
}
