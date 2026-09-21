/**
 * Tests for the MCP wiring (docs/PLAN.md, section 6, Phase 4) and for the
 * R11 path guard.
 *
 * The tools' own behavior is covered by test/tools/**; what is checked here
 * is everything the server layer is responsible for: that all thirteen tools
 * are registered under their `angular_` names with schemas and read-only
 * annotations, that a client talking real MCP over an in-memory transport
 * can list and call them, that the resources and the prompt exist, that a
 * failing tool comes back as a tool result rather than a protocol error, and
 * that no path outside the analyzed project is ever accepted.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath, sep } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PLAN_CHANGE_PROMPT_NAME } from '../src/prompts/index.js';
import { PROJECT_SUMMARY_URI, RULES_URI } from '../src/resources/index.js';
import { ALL_TOOLS, SERVER_NAME, createServer } from '../src/server.js';
import { resolveProjectRoot } from '../src/index.js';
import { InvalidInputError } from '../src/tools/index.js';
import { assertInsideRoot, assertProjectRoot, validatePathInputs } from '../src/tools/internal/paths.js';

const EXPECTED_TOOL_NAMES = [
  'angular_index_project',
  'angular_get_index_status',
  'angular_find_symbol',
  'angular_get_component',
  'angular_get_service',
  'angular_get_route_tree',
  'angular_who_uses',
  'angular_get_template_bindings',
  'angular_list_http_calls',
  'angular_impact_of',
  'angular_list_rules',
  'angular_check_rules',
  'angular_explain_layer',
  'angular_find_similar',
  'angular_get_api_contract',
  'angular_list_decisions',
].sort();

describe('tool registry', () => {
  it('exposes exactly the tools docs/PLAN.md section 6 lists, all prefixed with angular_', () => {
    expect(ALL_TOOLS.map((tool) => tool.name).sort()).toEqual(EXPECTED_TOOL_NAMES);
  });

  it('declares an input schema, an output schema and read-only annotations on every tool', () => {
    for (const tool of ALL_TOOLS) {
      expect(Object.keys(tool.inputSchema).length, `${tool.name} input schema`).toBeGreaterThan(0);
      expect(Object.keys(tool.outputSchema).length, `${tool.name} output schema`).toBeGreaterThan(0);
      expect(tool.annotations.readOnlyHint, `${tool.name} readOnlyHint`).toBe(true);
      expect(tool.annotations.destructiveHint, `${tool.name} destructiveHint`).toBe(false);
      expect(tool.description.length, `${tool.name} description`).toBeGreaterThan(40);
    }
  });
});

describe('MCP server over an in-memory transport', () => {
  let projectRoot: string;
  let client: Client;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'server-test-'));
    await writeFile(join(projectRoot, 'package.json'), JSON.stringify({ name: 'fixture' }), 'utf8');

    const server = createServer({ projectRoot });
    client = new Client({ name: 'test-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  });

  afterEach(async () => {
    await client.close();
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('lists every tool with its annotations over the protocol', async () => {
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual(EXPECTED_TOOL_NAMES);
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint, `${tool.name} readOnlyHint`).toBe(true);
      expect(tool.inputSchema, `${tool.name} inputSchema`).toBeDefined();
      expect(tool.outputSchema, `${tool.name} outputSchema`).toBeDefined();
    }
  });

  it('exposes the two resources', async () => {
    const { resources } = await client.listResources();

    expect(resources.map((resource) => resource.uri).sort()).toEqual([PROJECT_SUMMARY_URI, RULES_URI].sort());
  });

  it('reports a project that was never indexed as not indexed, rather than as empty', async () => {
    const { contents } = await client.readResource({ uri: PROJECT_SUMMARY_URI });

    const first = contents[0] as { text?: string } | undefined;
    const summary = JSON.parse(String(first?.text)) as { indexed: boolean; reason?: string };
    expect(summary.indexed).toBe(false);
    expect(summary.reason).toMatch(/angular_index_project/);
  });

  it('exposes the angular_plan_change prompt and renders the request into it', async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.map((prompt) => prompt.name)).toContain(PLAN_CHANGE_PROMPT_NAME);

    const rendered = await client.getPrompt({
      name: PLAN_CHANGE_PROMPT_NAME,
      arguments: { request: 'add pagination to the user list' },
    });

    const text = String((rendered.messages[0]?.content as { text?: unknown }).text);
    expect(text).toContain('add pagination to the user list');
    expect(text).toContain('angular_impact_of');
    expect(text).toContain('angular_check_rules');
  });

  it('returns a tool error, not a protocol error, when a tool is called before indexing', async () => {
    const result = await client.callTool({ name: 'angular_find_symbol', arguments: { query: 'UserListComponent' } });

    expect(result.isError).toBe(true);
    // The message says what to do next, per the plan's "actionable errors".
    expect(String((result.content as { text: string }[])[0]?.text)).toMatch(/angular_index_project/);
  });

  it('rejects a root outside the analyzed project instead of reading it (R11)', async () => {
    const result = await client.callTool({
      name: 'angular_find_symbol',
      arguments: { query: 'anything', root: '/etc' },
    });

    expect(result.isError).toBe(true);
    expect(String((result.content as { text: string }[])[0]?.text)).toMatch(/resolves outside the analyzed project/);
  });

  it('rejects a traversing file path in a tool that takes one (R11)', async () => {
    const result = await client.callTool({
      name: 'angular_explain_layer',
      arguments: { file: '../../../../etc/passwd' },
    });

    expect(result.isError).toBe(true);
    expect(String((result.content as { text: string }[])[0]?.text)).toMatch(/resolves outside the analyzed project/);
  });

  it('rejects a traversing entry inside a list of files (R11)', async () => {
    const result = await client.callTool({
      name: 'angular_check_rules',
      arguments: { files: ['src/app/app.component.ts', '../../etc/shadow'] },
    });

    expect(result.isError).toBe(true);
    expect(String((result.content as { text: string }[])[0]?.text)).toMatch(/resolves outside the analyzed project/);
  });
});

describe('path guard', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'paths-test-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('accepts the root itself and paths under it', () => {
    expect(assertInsideRoot(root, '.', 'file')).toBe(resolvePath(root));
    expect(assertInsideRoot(root, 'src/app/app.component.ts', 'file')).toBe(join(root, 'src/app/app.component.ts'));
    expect(assertInsideRoot(root, join(root, 'src', 'main.ts'), 'file')).toBe(join(root, 'src', 'main.ts'));
  });

  it('rejects relative traversal, absolute escapes, and a sibling whose name shares the root prefix', () => {
    for (const escape of ['../outside.ts', '../../etc/passwd', '/etc/passwd', `..${sep}..`]) {
      expect(() => assertInsideRoot(root, escape, 'file'), escape).toThrow(InvalidInputError);
    }
    // "<root>-sibling" starts with the root's own path as a string but is not inside it.
    expect(() => assertInsideRoot(root, `${root}-sibling/secret.ts`, 'file')).toThrow(InvalidInputError);
  });

  it('defaults an omitted root to the configured one and rejects a different one', () => {
    expect(assertProjectRoot(root, undefined)).toBe(resolvePath(root));
    expect(assertProjectRoot(root, '')).toBe(resolvePath(root));
    expect(assertProjectRoot(root, root)).toBe(resolvePath(root));
    expect(() => assertProjectRoot(root, '/tmp')).toThrow(InvalidInputError);
  });

  it('ignores inputs that carry no path at all', () => {
    expect(() => validatePathInputs(root, undefined)).not.toThrow();
    expect(() => validatePathInputs(root, { query: 'UserListComponent', limit: 10 })).not.toThrow();
  });
});

describe('stdio entry point', () => {
  it('takes the project root from the first argument, then the env var, then the working directory', () => {
    expect(resolveProjectRoot(['/workspace/app'], {}, '/cwd')).toBe('/workspace/app');
    expect(resolveProjectRoot([], { ANGULAR_MCP_ROOT: '/from/env' }, '/cwd')).toBe('/from/env');
    expect(resolveProjectRoot([], {}, '/cwd')).toBe('/cwd');
    // A flag is not a path.
    expect(resolveProjectRoot(['--verbose'], {}, '/cwd')).toBe('/cwd');
  });

  it('names the server without a version number in the name, per the MCP naming guidance', () => {
    expect(SERVER_NAME).toBe('angular-mcp-server');
  });
});

describe('bounded responses (P6)', () => {
  it('paginates the structured violations array, not just the formatted response', async () => {
    const { checkRulesTool } = await import('../src/tools/rules_tools.js');

    // The formatted `result` was always bounded; the structured array beside
    // it was not, which would have put the whole unbounded payload back into
    // the caller's context — the exact problem this server exists to avoid.
    const description = checkRulesTool.outputSchema.violations.description ?? '';
    expect(description).toMatch(/bounded by "limit"\/"offset"/);
  });

  it('gives every list tool a limit, an offset and a format', () => {
    const listTools = ALL_TOOLS.filter((tool) => 'result' in tool.outputSchema);

    expect(listTools.length).toBeGreaterThan(5);
    for (const tool of listTools) {
      expect(Object.keys(tool.inputSchema), tool.name).toEqual(
        expect.arrayContaining(['limit', 'offset', 'format']),
      );
    }
  });
});
