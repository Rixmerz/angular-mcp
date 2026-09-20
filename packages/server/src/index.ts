#!/usr/bin/env node
/**
 * stdio entry point (docs/PLAN.md, section 4.1).
 *
 * stdout carries the MCP protocol and nothing else: every diagnostic goes to
 * stderr. A stray `console.log` anywhere in this process would corrupt the
 * stream, which is why nothing in `src/` logs to stdout and why the failure
 * paths below write to stderr explicitly.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { resolve as resolvePath } from 'node:path';

import { SERVER_NAME, SERVER_VERSION, createServer } from './server.js';

/**
 * The workspace to analyze: the first CLI argument, else `ANGULAR_MCP_ROOT`,
 * else the working directory the client started the server in. It is fixed
 * for the process's lifetime — every tool path is validated against it (R11).
 */
export function resolveProjectRoot(argv: readonly string[], env: NodeJS.ProcessEnv, cwd: string): string {
  const fromArgs = argv.find((argument) => !argument.startsWith('-'));
  return resolvePath(fromArgs ?? env['ANGULAR_MCP_ROOT'] ?? cwd);
}

async function main(): Promise<void> {
  const projectRoot = resolveProjectRoot(process.argv.slice(2), process.env, process.cwd());

  const server = createServer({ projectRoot });
  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write(`${SERVER_NAME} ${SERVER_VERSION} ready on stdio, analyzing "${projectRoot}"\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${SERVER_NAME}: failed to start: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
