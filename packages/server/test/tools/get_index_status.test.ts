import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { getIndexStatusTool } from '../../src/tools/get_index_status.js';
import { indexProjectTool } from '../../src/tools/index_project.js';
import { ToolContext } from '../../src/tools/internal/context.js';

import { createTempProject } from './internal/tempProject.js';
import type { TempProject } from './internal/tempProject.js';

const TSCONFIG = JSON.stringify({
  compilerOptions: { target: 'ES2022', module: 'ES2022', moduleResolution: 'bundler', experimentalDecorators: true },
});

const SERVICE_SOURCE = `
  import { Injectable } from '@angular/core';
  @Injectable({ providedIn: 'root' })
  export class UserService {}
`;

let project: TempProject | undefined;

afterEach(async () => {
  await project?.cleanup();
  project = undefined;
});

describe('angular_get_index_status', () => {
  it('reports never_indexed before angular_index_project has run', async () => {
    project = await createTempProject({ 'tsconfig.json': TSCONFIG, 'user.service.ts': SERVICE_SOURCE });
    const context = new ToolContext({ defaultRoot: project.root });

    const output = await getIndexStatusTool.run({}, context);

    expect(output.status).toBe('never_indexed');
    expect(output.message).toMatch(/angular_index_project/);
  });

  it('reports fresh right after indexing', async () => {
    project = await createTempProject({ 'tsconfig.json': TSCONFIG, 'user.service.ts': SERVICE_SOURCE });
    const context = new ToolContext({ defaultRoot: project.root });

    await indexProjectTool.run({}, context);
    const output = await getIndexStatusTool.run({}, context);

    expect(output.status).toBe('fresh');
  });

  it('reports stale after a file changes, and lists it as pending', async () => {
    project = await createTempProject({ 'tsconfig.json': TSCONFIG, 'user.service.ts': SERVICE_SOURCE });
    const context = new ToolContext({ defaultRoot: project.root });

    await indexProjectTool.run({}, context);
    await writeFile(join(project.root, 'user.service.ts'), `${SERVICE_SOURCE}\n// changed`, 'utf8');

    const output = await getIndexStatusTool.run({ format: 'json' }, context);

    expect(output.status).toBe('stale');
    if (output.result.format !== 'json') throw new Error('expected json');
    expect(output.result.data.items.some((item) => item.detail?.file === 'user.service.ts')).toBe(true);
  });
});
