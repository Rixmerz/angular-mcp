import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { PHASE_1_TOOLS } from '../../src/tools/index.js';

const EXPECTED_NAMES = [
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
];

describe('PHASE_1_TOOLS registry', () => {
  it('has exactly the ten Phase 1 tools from docs/PLAN.md section 6', () => {
    expect(PHASE_1_TOOLS.map((tool) => tool.name)).toEqual(EXPECTED_NAMES);
  });

  it.each(PHASE_1_TOOLS.map((tool) => [tool.name, tool] as const))('%s is prefixed "angular_" and read-only', (name, tool) => {
    expect(name.startsWith('angular_')).toBe(true);
    expect(tool.annotations.readOnlyHint).toBe(true);
    expect(tool.annotations.destructiveHint).toBe(false);
    expect(tool.annotations.idempotentHint).toBe(true);
    expect(tool.annotations.openWorldHint).toBe(false);
  });

  it.each(PHASE_1_TOOLS.map((tool) => [tool.name, tool] as const))('%s declares a non-empty Zod input schema and output schema', (_name, tool) => {
    expect(Object.keys(tool.inputSchema).length).toBeGreaterThan(0);
    expect(Object.keys(tool.outputSchema).length).toBeGreaterThan(0);
    for (const schema of Object.values(tool.inputSchema)) {
      expect(schema).toBeInstanceOf(z.ZodType);
    }
    for (const schema of Object.values(tool.outputSchema)) {
      expect(schema).toBeInstanceOf(z.ZodType);
    }
  });

  it.each(PHASE_1_TOOLS.map((tool) => [tool.name, tool] as const))('%s has a non-empty description', (_name, tool) => {
    expect(tool.description.length).toBeGreaterThan(20);
  });

  it('every field of every input schema has a description (docs/PLAN.md section 6)', () => {
    for (const tool of PHASE_1_TOOLS) {
      for (const [field, schema] of Object.entries(tool.inputSchema)) {
        expect(schema.description, `${tool.name}.inputSchema.${field} has no description`).toBeTruthy();
      }
    }
  });

  it('rejects a call before angular_index_project has run, with an actionable message', async () => {
    const { ToolContext } = await import('../../src/tools/internal/context.js');
    const context = new ToolContext({ defaultRoot: '/nowhere' });

    for (const tool of PHASE_1_TOOLS) {
      if (tool.name === 'angular_index_project' || tool.name === 'angular_get_index_status') continue;

      const minimalInput: Record<string, unknown> = {};
      if ('ref' in tool.inputSchema) minimalInput.ref = 'Whatever';
      if ('query' in tool.inputSchema) minimalInput.query = 'Whatever';
      if ('refs' in tool.inputSchema) minimalInput.refs = ['Whatever'];

      await expect(tool.run(minimalInput, context)).rejects.toThrow(/angular_index_project/);
    }
  });
});
