import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as angularCompiler from '@angular/compiler';
import * as typescript from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ComponentNode, HttpCallNode, RouteNode, TemplateNode } from '../../src/graph/model.js';
import { indexProject } from '../../src/indexer/index.js';

async function writeFiles(root: string, files: Readonly<Record<string, string>>): Promise<void> {
  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = join(root, relativePath);
    await mkdir(join(fullPath, '..'), { recursive: true });
    await writeFile(fullPath, content, 'utf8');
  }
}

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
  import { Component, inject, signal } from '@angular/core';
  import { UserService } from './user.service';

  @Component({
    selector: 'app-user-list',
    standalone: true,
    template: '<div>{{ count() }}</div>',
  })
  export class UserListComponent {
    private readonly userService = inject(UserService);
    count = signal(0);
  }
`;

const ROUTES_SOURCE = `
  import { Routes } from '@angular/router';
  import { UserListComponent } from './user-list.component';

  export const routes: Routes = [
    { path: 'users', component: UserListComponent },
  ];
`;

const MODULE_SOURCE = `
  import { NgModule } from '@angular/core';
  import { CommonModule } from '@angular/common';

  @NgModule({
    declarations: [],
    imports: [CommonModule],
    providers: [],
  })
  export class AppModule {}
`;

const SPEC_SOURCE = `
  import { UserService } from './user.service';

  describe('UserService', () => {
    it('exists', () => {
      expect(new UserService()).toBeTruthy();
    });
  });
`;

const BASE_FILES = {
  'tsconfig.json': TSCONFIG,
  'src/app/user.service.ts': SERVICE_SOURCE,
  'src/app/user-list.component.ts': COMPONENT_SOURCE,
  'src/app/app.routes.ts': ROUTES_SOURCE,
  'src/app/app.module.ts': MODULE_SOURCE,
  'src/app/user.service.spec.ts': SPEC_SOURCE,
};

describe('indexProject', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'index-project-test-'));
    await writeFiles(root, BASE_FILES);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('indexes a whole project by calling every extractor and reports the summary', async () => {
    const { graph, stats } = await indexProject({ root, typescript, angularCompiler });

    // decorators.ts
    expect(stats.nodesByType.Component).toBe(1);
    expect(stats.nodesByType.Service).toBe(1);
    // modules.ts
    expect(stats.nodesByType.NgModule).toBe(1);
    // routes.ts
    expect(stats.nodesByType.Route).toBe(1);
    // signals.ts
    expect(stats.nodesByType.Signal).toBe(1);
    // http.ts
    expect(stats.nodesByType.HttpCall).toBe(1);
    // specs.ts
    expect(stats.nodesByType.Spec).toBe(1);
    // templates.ts (the component's inline template)
    expect(stats.nodesByType.Template).toBe(1);

    const component = graph.nodesByName('UserListComponent')[0] as ComponentNode;
    expect(component.kind).toBe('Component');

    // di.ts: UserListComponent injects UserService via inject().
    const injectsEdges = graph.edgesFrom(component.id, 'injects');
    expect(injectsEdges).toHaveLength(1);
    expect(injectsEdges[0]?.to).toBe('src/app/user.service.ts#UserService');

    // routes.ts resolved the route's component against the same component id.
    const routeNode = graph.nodesByKind('Route')[0] as RouteNode;
    expect(routeNode.componentRef).toBe(component.id);

    // templates.ts parsed the inline template with no errors.
    const templateNode = graph.nodesByKind('Template')[0] as TemplateNode | undefined;
    expect(templateNode?.parseErrors).toEqual([]);

    expect(stats.parseErrors).toEqual([]);
    expect(stats.brokenFiles).toEqual([]);
    expect(stats.filesProcessed).toBe(Object.keys(BASE_FILES).length - 1); // every file but tsconfig.json
    expect(stats.filesReindexed).toBe(stats.filesProcessed);
    expect(stats.filesReused).toBe(0);
    expect(stats.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('reports a template parse error without failing the index', async () => {
    await writeFiles(root, {
      'src/app/broken.component.ts': `
        import { Component } from '@angular/core';

        @Component({
          selector: 'app-broken',
          standalone: true,
          template: '<div [foo]="bar</div>',
        })
        export class BrokenComponent {}
      `,
    });

    const { stats } = await indexProject({ root, typescript, angularCompiler, force: true });

    expect(stats.parseErrors.length).toBeGreaterThan(0);
    expect(stats.parseErrors[0]?.file).toBe('src/app/broken.component.ts');
    expect(stats.brokenFiles).toEqual([]);
  });

  describe('incremental reindexing', () => {
    it('only reprocesses the file whose hash changed on the next run', async () => {
      const first = await indexProject({ root, typescript, angularCompiler });
      expect(first.stats.filesReindexed).toBe(first.stats.filesProcessed);

      await writeFiles(root, {
        'src/app/user.service.ts': SERVICE_SOURCE.replace('/api/users', '/api/v2/users'),
      });

      const second = await indexProject({ root, typescript, angularCompiler });

      expect(second.stats.filesReindexed).toBe(1);
      expect(second.stats.filesReused).toBe(first.stats.filesProcessed - 1);
      expect(second.stats.filesProcessed).toBe(first.stats.filesProcessed);

      const httpCall = second.graph.nodesByKind('HttpCall')[0] as HttpCallNode | undefined;
      expect(httpCall?.urlPattern).toBe('/api/v2/users');
    });

    it('reindexes nothing when nothing changed between two runs', async () => {
      await indexProject({ root, typescript, angularCompiler });
      const second = await indexProject({ root, typescript, angularCompiler });

      expect(second.stats.filesReindexed).toBe(0);
      expect(second.stats.filesReused).toBe(second.stats.filesProcessed);
      expect(second.graph.nodesByKind('Component')).toHaveLength(1);
    });

    it('reindexes every file again when force is set, ignoring the existing cache', async () => {
      await indexProject({ root, typescript, angularCompiler });
      const forced = await indexProject({ root, typescript, angularCompiler, force: true });

      expect(forced.stats.filesReindexed).toBe(forced.stats.filesProcessed);
      expect(forced.stats.filesReused).toBe(0);
    });

    it('drops facts for a file that was deleted since the last run', async () => {
      await indexProject({ root, typescript, angularCompiler });

      await rm(join(root, 'src/app/app.module.ts'));

      const second = await indexProject({ root, typescript, angularCompiler });

      expect(second.graph.nodesByKind('NgModule')).toHaveLength(0);
    });
  });

  it('does not abort the whole index when one file throws while being extracted', async () => {
    await writeFiles(root, {
      'src/app/broken-extraction.service.ts': `
        import { Injectable } from '@angular/core';

        @Injectable({ providedIn: 'root' })
        export class BrokenExtractionService {}
      `,
    });

    vi.resetModules();
    vi.doMock('../../src/indexer/extractors/decorators.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../src/indexer/extractors/decorators.js')>();
      return {
        ...actual,
        extractDecorators: (ts: typeof typescript, sourceFile: typescript.SourceFile, relativePath: string) => {
          if (relativePath === 'src/app/broken-extraction.service.ts') {
            throw new Error('simulated extractor failure');
          }
          return actual.extractDecorators(ts, sourceFile, relativePath);
        },
      };
    });

    const { indexProject: mockedIndexProject } = await import('../../src/indexer/index.js');
    const { stats } = await mockedIndexProject({ root, typescript, angularCompiler, force: true });

    expect(stats.brokenFiles).toHaveLength(1);
    expect(stats.brokenFiles[0]?.file).toBe('src/app/broken-extraction.service.ts');
    expect(stats.brokenFiles[0]?.message).toContain('simulated extractor failure');

    // Every other file was still indexed despite the failure.
    expect(stats.nodesByType.Component).toBe(1);
    expect(stats.nodesByType.NgModule).toBe(1);
    expect(stats.nodesByType.Route).toBe(1);

    vi.doUnmock('../../src/indexer/extractors/decorators.js');
    vi.resetModules();
  });
});
