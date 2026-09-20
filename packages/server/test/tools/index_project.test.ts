import { afterEach, describe, expect, it } from 'vitest';

import { indexProjectTool } from '../../src/tools/index_project.js';
import { InvalidInputError } from '../../src/tools/internal/errors.js';
import { ToolContext } from '../../src/tools/internal/context.js';

import { createTempProject } from './internal/tempProject.js';
import type { TempProject } from './internal/tempProject.js';

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: 'ES2022',
    module: 'ES2022',
    moduleResolution: 'bundler',
    experimentalDecorators: true,
  },
});

const SERVICE_SOURCE = `
  import { Injectable, inject } from '@angular/core';
  import { HttpClient } from '@angular/common/http';

  @Injectable({ providedIn: 'root' })
  export class UserService {
    private http = inject(HttpClient);

    getUsers() {
      return this.http.get<string[]>('/api/users');
    }
  }
`;

const COMPONENT_SOURCE = `
  import { Component, inject } from '@angular/core';
  import { UserService } from './user.service';

  @Component({
    selector: 'app-user-list',
    standalone: true,
    template: '<div>{{ userService }}</div>',
  })
  export class UserListComponent {
    private readonly userService = inject(UserService);
  }
`;

let project: TempProject | undefined;

afterEach(async () => {
  await project?.cleanup();
  project = undefined;
});

describe('angular_index_project', () => {
  it('indexes a project from scratch and stores the graph in the context', async () => {
    project = await createTempProject({
      'tsconfig.json': TSCONFIG,
      'user.service.ts': SERVICE_SOURCE,
      'user-list.component.ts': COMPONENT_SOURCE,
    });
    const context = new ToolContext({ defaultRoot: project.root });

    const output = await indexProjectTool.run({ format: 'json' }, context);

    expect(output.workspaceKind).toBe('tsconfig-only');
    expect(output.nodesByType.Component).toBe(1);
    expect(output.nodesByType.Service).toBe(1);
    expect(output.filesReindexed).toBeGreaterThan(0);
    expect(output.angularVersion).toBeTruthy();
    expect(context.getStateFor(project.root)).toBeDefined();
  });

  it('is incremental: a second run with no changes reuses every file', async () => {
    project = await createTempProject({
      'tsconfig.json': TSCONFIG,
      'user.service.ts': SERVICE_SOURCE,
    });
    const context = new ToolContext({ defaultRoot: project.root });

    await indexProjectTool.run({ format: 'json' }, context);
    const second = await indexProjectTool.run({ format: 'json' }, context);

    expect(second.filesReindexed).toBe(0);
    expect(second.filesReused).toBeGreaterThan(0);
  });

  it('force re-extracts every file even when nothing changed', async () => {
    project = await createTempProject({
      'tsconfig.json': TSCONFIG,
      'user.service.ts': SERVICE_SOURCE,
    });
    const context = new ToolContext({ defaultRoot: project.root });

    await indexProjectTool.run({}, context);
    const forced = await indexProjectTool.run({ force: true, format: 'json' }, context);

    expect(forced.filesReindexed).toBeGreaterThan(0);
    expect(forced.filesReused).toBe(0);
  });

  it('rejects an unknown "project" name before indexing', async () => {
    project = await createTempProject({ 'tsconfig.json': TSCONFIG, 'user.service.ts': SERVICE_SOURCE });
    const context = new ToolContext({ defaultRoot: project.root });

    await expect(indexProjectTool.run({ project: 'does-not-exist' }, context)).rejects.toBeInstanceOf(InvalidInputError);
  });
});
