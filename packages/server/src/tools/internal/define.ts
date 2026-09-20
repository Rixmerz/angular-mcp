/**
 * Common shape for every MCP tool. See docs/PLAN.md, section 6 and section
 * 4.1 ("Server. A thin layer: registers tools with Zod, annotations and
 * output schemas. No domain logic.").
 *
 * `inputSchema`/`outputSchema` are plain Zod-raw-shapes (an object whose
 * values are Zod schemas), matching `@modelcontextprotocol/sdk`'s
 * `registerTool(name, { inputSchema, outputSchema, annotations }, cb)`
 * convention, so a future `server.ts` can register these definitions
 * directly. `run()` parses the input and validates the output against those
 * same shapes, which is also what makes each tool independently testable
 * without spinning up an MCP server.
 */

import { z } from 'zod';

import type { ToolContext } from './context.js';

export type ZodShape = Record<string, z.ZodTypeAny>;

/**
 * Subset of the MCP `ToolAnnotations` shape this server actually declares.
 * See docs/PLAN.md, section 6: "Every read tool has `readOnlyHint: true`."
 */
export interface ToolAnnotations {
  readonly title?: string;
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
}

/**
 * Every Phase 1 tool is a pure query: it never mutates the analyzed project,
 * it is safe to retry, and it never reaches outside the local filesystem
 * (P2/P3, docs/PLAN.md section 2 and 6).
 */
export const READ_ONLY_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export interface ToolDefinition<InputShape extends ZodShape, OutputShape extends ZodShape> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: InputShape;
  readonly outputSchema: OutputShape;
  readonly annotations: ToolAnnotations;
  /** Parses `rawInput`, runs the handler, and validates the result against `outputSchema`. */
  run(rawInput: unknown, context: ToolContext): Promise<z.infer<z.ZodObject<OutputShape>>>;
}

export interface ToolConfig<InputShape extends ZodShape, OutputShape extends ZodShape> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: InputShape;
  readonly outputSchema: OutputShape;
  readonly annotations: ToolAnnotations;
  handler(input: z.infer<z.ZodObject<InputShape>>, context: ToolContext): Promise<z.infer<z.ZodObject<OutputShape>>>;
}

export function defineTool<InputShape extends ZodShape, OutputShape extends ZodShape>(
  config: ToolConfig<InputShape, OutputShape>,
): ToolDefinition<InputShape, OutputShape> {
  const inputObject = z.object(config.inputSchema);
  const outputObject = z.object(config.outputSchema);

  return {
    name: config.name,
    description: config.description,
    inputSchema: config.inputSchema,
    outputSchema: config.outputSchema,
    annotations: config.annotations,
    async run(rawInput, context) {
      const parsedInput = inputObject.parse(rawInput ?? {});
      const output = await config.handler(parsedInput, context);
      return outputObject.parse(output);
    },
  };
}
