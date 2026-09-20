import * as typescript from 'typescript';
import { describe, expect, it } from 'vitest';

import { extractSpec } from '../../src/indexer/extractors/specs.js';

function parse(source: string, fileName: string): typescript.SourceFile {
  return typescript.createSourceFile(fileName, source, typescript.ScriptTarget.Latest, true, typescript.ScriptKind.TS);
}

describe('extractSpec', () => {
  it('associates a spec to the symbol it imports from the module matching its own name (naming convention + import)', () => {
    const sourceFile = parse(
      `
        import { TestBed } from '@angular/core/testing';
        import { UserService } from './user.service';

        describe('UserService', () => {
          it('should be created', () => {
            const service = TestBed.inject(UserService);
            expect(service).toBeTruthy();
          });
        });
      `,
      'src/app/core/services/user.service.spec.ts',
    );

    const { node, edges } = extractSpec(typescript, sourceFile, 'src/app/core/services/user.service.spec.ts');

    expect(node.kind).toBe('Spec');
    expect(node.id).toBe('src/app/core/services/user.service.spec.ts#Spec');
    expect(node.describes).toEqual(['UserService']);
    expect(node.testedRefs).toEqual(['src/app/core/services/user.service.ts#UserService']);

    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      kind: 'tested_by',
      from: 'src/app/core/services/user.service.ts#UserService',
      to: 'src/app/core/services/user.service.spec.ts#Spec',
      confidence: 'inferred',
    });
  });

  it('associates a component spec importing the component from the sibling module, ignoring unrelated imports', () => {
    const sourceFile = parse(
      `
        import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
        import { provideHttpClient } from '@angular/common/http';
        import { TestBed } from '@angular/core/testing';

        import { UserListComponent } from './user-list.component';

        describe('UserListComponent', () => {
          it('should create', () => {
            const fixture = TestBed.createComponent(UserListComponent);
            expect(fixture.componentInstance).toBeTruthy();
          });
        });
      `,
      'src/app/features/users/user-list/user-list.component.spec.ts',
    );

    const { node, edges } = extractSpec(
      typescript,
      sourceFile,
      'src/app/features/users/user-list/user-list.component.spec.ts',
    );

    expect(node.testedRefs).toEqual([
      'src/app/features/users/user-list/user-list.component.ts#UserListComponent',
    ]);
    expect(edges).toHaveLength(1);
    // Nothing from @angular/common/http, @angular/common/http/testing or @angular/core/testing counts as a tested ref.
    expect(edges[0]!.from).toBe('src/app/features/users/user-list/user-list.component.ts#UserListComponent');
  });

  it('ignores an unrelated relative import (e.g. a model imported via ../) even though it is relative', () => {
    const sourceFile = parse(
      `
        import { Order } from '../models/order.model';

        describe('OrderService', () => {});
      `,
      'src/app/core/services/order.service.spec.ts',
    );

    const { node, edges } = extractSpec(typescript, sourceFile, 'src/app/core/services/order.service.spec.ts');
    expect(node.testedRefs).toEqual([]);
    expect(edges).toEqual([]);
  });

  it('matches a parent-relative import that normalizes back to the spec\'s own conventional module', () => {
    const sourceFile = parse(
      `
        import { OrderService } from '../../core/services/order.service';

        describe('OrderService', () => {});
      `,
      'src/app/core/services/order.service.spec.ts',
    );

    // '../../core/services/order.service', resolved and normalized from
    // 'src/app/core/services', lands back on 'src/app/core/services/order.service' —
    // the spec's own conventional module — so it still counts.
    const { node } = extractSpec(typescript, sourceFile, 'src/app/core/services/order.service.spec.ts');
    expect(node.testedRefs).toEqual(['src/app/core/services/order.service.ts#OrderService']);
  });

  it('never invents a tested symbol when the spec does not import anything from its conventional module', () => {
    const sourceFile = parse(
      `
        describe('WidgetService', () => {
          it('does nothing useful', () => {
            expect(true).toBe(true);
          });
        });
      `,
      'src/app/core/services/widget.service.spec.ts',
    );

    const { node, edges } = extractSpec(typescript, sourceFile, 'src/app/core/services/widget.service.spec.ts');
    expect(node.testedRefs).toEqual([]);
    expect(edges).toEqual([]);
    expect(node.describes).toEqual(['WidgetService']);
  });

  it('collects multiple describe names and multiple named imports from the conventional module', () => {
    const sourceFile = parse(
      `
        import { WidgetService, WidgetKind } from './widget.service';

        describe('WidgetService', () => {
          describe('#list', () => {});
        });
      `,
      'src/app/core/services/widget.service.spec.ts',
    );

    const { node } = extractSpec(typescript, sourceFile, 'src/app/core/services/widget.service.spec.ts');
    expect(node.describes).toEqual(['WidgetService', '#list']);
    expect(node.testedRefs).toEqual([
      'src/app/core/services/widget.service.ts#WidgetService',
      'src/app/core/services/widget.service.ts#WidgetKind',
    ]);
  });

  it('uses the imported name, not the local alias, when the import is renamed', () => {
    const sourceFile = parse(
      `
        import { WidgetService as Sut } from './widget.service';

        describe('WidgetService', () => {});
      `,
      'src/app/core/services/widget.service.spec.ts',
    );

    const { node } = extractSpec(typescript, sourceFile, 'src/app/core/services/widget.service.spec.ts');
    expect(node.testedRefs).toEqual(['src/app/core/services/widget.service.ts#WidgetService']);
  });
});
