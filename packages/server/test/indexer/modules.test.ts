import * as typescript from 'typescript';
import { describe, expect, it } from 'vitest';

import { extractModules } from '../../src/indexer/extractors/modules.js';
import type { ImportsEdge, NgModuleNode, ProvidesEdge } from '../../src/graph/model.js';

function parse(source: string, fileName = 'src/app/app.module.ts'): typescript.SourceFile {
  return typescript.createSourceFile(fileName, source, typescript.ScriptTarget.Latest, true, typescript.ScriptKind.TS);
}

describe('extractModules', () => {
  it('extracts declarations, imports, exports and providers as written', () => {
    const sourceFile = parse(`
      import { NgModule } from '@angular/core';
      import { CommonModule } from '@angular/common';

      export class UserListComponent {}
      export class UserService {}

      @NgModule({
        declarations: [UserListComponent],
        imports: [CommonModule],
        exports: [UserListComponent],
        providers: [UserService],
      })
      export class UserModule {}
    `);

    const { nodes } = extractModules(typescript, sourceFile, 'src/app/app.module.ts');
    expect(nodes).toHaveLength(1);

    const moduleNode = nodes[0] as NgModuleNode;
    expect(moduleNode.kind).toBe('NgModule');
    expect(moduleNode.id).toBe('src/app/app.module.ts#UserModule');
    expect(moduleNode.declarations).toEqual(['UserListComponent']);
    expect(moduleNode.imports).toEqual(['CommonModule']);
    expect(moduleNode.exports).toEqual(['UserListComponent']);
    expect(moduleNode.providers).toEqual(['UserService']);
  });

  it('produces no node for a class without @NgModule', () => {
    const sourceFile = parse(`export class PlainService {}`);
    const { nodes, edges } = extractModules(typescript, sourceFile, 'src/app/app.module.ts');
    expect(nodes).toEqual([]);
    expect(edges).toEqual([]);
  });

  it('emits an imports edge for each plain identifier in the imports array', () => {
    const sourceFile = parse(`
      import { NgModule } from '@angular/core';
      import { SharedModule } from '../shared/shared.module';

      export class LocalWidgetModule {}

      @NgModule({ imports: [LocalWidgetModule, SharedModule] })
      export class FeatureModule {}
    `, 'src/app/feature/feature.module.ts');

    const { edges } = extractModules(typescript, sourceFile, 'src/app/feature/feature.module.ts');
    const importsEdges = edges.filter((e): e is ImportsEdge => e.kind === 'imports');
    expect(importsEdges).toHaveLength(2);

    const local = importsEdges.find((e) => e.to === 'src/app/feature/feature.module.ts#LocalWidgetModule')!;
    expect(local.confidence).toBe('certain');
    expect(local.from).toBe('src/app/feature/feature.module.ts#FeatureModule');

    const shared = importsEdges.find((e) => e.to === 'src/app/shared/shared.module.ts#SharedModule')!;
    expect(shared.confidence).toBe('inferred');
  });

  it('emits a provides edge for a plain identifier and for the provide token of an object provider', () => {
    const sourceFile = parse(`
      import { NgModule } from '@angular/core';

      export class UserService {}
      export const API_URL = 'token';

      @NgModule({
        providers: [UserService, { provide: API_URL, useValue: 'https://example.test' }],
      })
      export class AppModule {}
    `);

    const { edges } = extractModules(typescript, sourceFile, 'src/app/app.module.ts');
    const providesEdges = edges.filter((e): e is ProvidesEdge => e.kind === 'provides');
    expect(providesEdges).toHaveLength(2);

    const serviceEdge = providesEdges.find((e) => e.to === 'src/app/app.module.ts#UserService')!;
    expect(serviceEdge.confidence).toBe('certain');
    expect(serviceEdge.from).toBe('src/app/app.module.ts#AppModule');

    const tokenEdge = providesEdges.find((e) => e.to === 'src/app/app.module.ts#API_URL')!;
    expect(tokenEdge.confidence).toBe('certain');
  });

  it('flattens nested provider arrays', () => {
    const sourceFile = parse(`
      import { NgModule } from '@angular/core';

      export class UserService {}
      export class LoggerService {}

      @NgModule({ providers: [[UserService, LoggerService]] })
      export class AppModule {}
    `);

    const { edges } = extractModules(typescript, sourceFile, 'src/app/app.module.ts');
    const providesEdges = edges.filter((e): e is ProvidesEdge => e.kind === 'provides');
    const targets = providesEdges.map((e) => e.to).sort();

    expect(targets).toEqual(['src/app/app.module.ts#LoggerService', 'src/app/app.module.ts#UserService']);
  });

  it('does not emit an imports edge for a non-identifier element like RouterModule.forRoot(routes)', () => {
    const sourceFile = parse(`
      import { NgModule } from '@angular/core';
      import { RouterModule } from '@angular/router';

      const routes = [];

      @NgModule({ imports: [RouterModule.forRoot(routes)] })
      export class AppRoutingModule {}
    `);

    const { nodes, edges } = extractModules(typescript, sourceFile, 'src/app/app.module.ts');
    expect(nodes[0]!.imports).toEqual(['RouterModule.forRoot(routes)']);
    expect(edges.filter((e) => e.kind === 'imports')).toEqual([]);
  });

  it('falls back to unknown confidence for a service imported from a non-relative package', () => {
    const sourceFile = parse(`
      import { NgModule } from '@angular/core';
      import { HttpClientModule } from '@angular/common/http';

      @NgModule({ imports: [HttpClientModule] })
      export class AppModule {}
    `);

    const { edges } = extractModules(typescript, sourceFile, 'src/app/app.module.ts');
    const edge = edges.find((e): e is ImportsEdge => e.kind === 'imports')!;

    expect(edge.to).toBe('src/app/app.module.ts#HttpClientModule');
    expect(edge.confidence).toBe('unknown');
  });
});
