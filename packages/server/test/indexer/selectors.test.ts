import * as typescript from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  extractStandaloneComponentImports,
  matchSelector,
  resolveComponentScope,
  resolveNgModuleDeclarations,
} from '../../src/indexer/extractors/selectors.js';
import type { SelectorTargetNode } from '../../src/indexer/extractors/selectors.js';
import type { ComponentNode, DirectiveNode, NgModuleNode, PipeNode } from '../../src/graph/model.js';

function parse(source: string, fileName: string): typescript.SourceFile {
  return typescript.createSourceFile(fileName, source, typescript.ScriptTarget.Latest, true, typescript.ScriptKind.TS);
}

function component(overrides: Partial<ComponentNode> & { path: string; name: string }): ComponentNode {
  return {
    kind: 'Component',
    id: `${overrides.path}#${overrides.name}`,
    standalone: true,
    changeDetection: 'Default',
    inlineTemplate: false,
    stylePaths: [],
    inputs: [],
    outputs: [],
    signals: [],
    lifecycleHooks: [],
    hostBindings: [],
    ...overrides,
  };
}

function directive(overrides: Partial<DirectiveNode> & { path: string; name: string }): DirectiveNode {
  return {
    kind: 'Directive',
    id: `${overrides.path}#${overrides.name}`,
    standalone: true,
    inputs: [],
    outputs: [],
    hostDirectives: [],
    ...overrides,
  };
}

function pipe(overrides: Partial<PipeNode> & { path: string; name: string }): PipeNode {
  return {
    kind: 'Pipe',
    id: `${overrides.path}#${overrides.name}`,
    standalone: true,
    pure: true,
    ...overrides,
  };
}

describe('extractStandaloneComponentImports', () => {
  it('resolves a local class as certain and a relatively-imported one as inferred', () => {
    const sourceFile = parse(
      `
        import { Component } from '@angular/core';
        import { ChildComponent } from '../shared/child.component';

        export class LocalDirective {}

        @Component({
          selector: 'app-parent',
          standalone: true,
          imports: [LocalDirective, ChildComponent],
          template: '',
        })
        export class ParentComponent {}
      `,
      'src/app/parent/parent.component.ts',
    );

    const refs = extractStandaloneComponentImports(typescript, sourceFile, 'src/app/parent/parent.component.ts', 'ParentComponent');
    expect(refs).toHaveLength(2);

    const local = refs.find((r) => r.nodeId === 'src/app/parent/parent.component.ts#LocalDirective')!;
    expect(local.confidence).toBe('certain');

    const imported = refs.find((r) => r.nodeId === 'src/app/shared/child.component.ts#ChildComponent')!;
    expect(imported.confidence).toBe('inferred');
  });

  it('skips a non-identifier element, same as the @NgModule imports array', () => {
    const sourceFile = parse(
      `
        import { Component } from '@angular/core';
        import { RouterModule } from '@angular/router';

        @Component({ selector: 'app-root', imports: [RouterModule.forChild([])], template: '' })
        export class RootComponent {}
      `,
      'src/app/root.component.ts',
    );

    const refs = extractStandaloneComponentImports(typescript, sourceFile, 'src/app/root.component.ts', 'RootComponent');
    expect(refs).toEqual([]);
  });

  it('returns nothing for a class with no @Component decorator', () => {
    const sourceFile = parse(`export class PlainClass {}`, 'src/app/plain.ts');
    const refs = extractStandaloneComponentImports(typescript, sourceFile, 'src/app/plain.ts', 'PlainClass');
    expect(refs).toEqual([]);
  });
});

describe('resolveNgModuleDeclarations', () => {
  it('resolves plain-identifier declarations against the module file, local and imported', () => {
    const sourceFile = parse(
      `
        import { NgModule } from '@angular/core';
        import { SharedPipe } from '../shared/shared.pipe';

        export class ListComponent {}

        @NgModule({ declarations: [ListComponent, SharedPipe] })
        export class ListModule {}
      `,
      'src/app/list/list.module.ts',
    );

    const refs = resolveNgModuleDeclarations(typescript, sourceFile, 'src/app/list/list.module.ts', [
      'ListComponent',
      'SharedPipe',
    ]);

    expect(refs).toEqual([
      { nodeId: 'src/app/list/list.module.ts#ListComponent', confidence: 'certain' },
      { nodeId: 'src/app/shared/shared.pipe.ts#SharedPipe', confidence: 'inferred' },
    ]);
  });

  it('ignores a declaration that is not a plain identifier', () => {
    const sourceFile = parse(`import { NgModule } from '@angular/core'; @NgModule({}) export class M {}`, 'src/app/m.module.ts');
    const refs = resolveNgModuleDeclarations(typescript, sourceFile, 'src/app/m.module.ts', ['Foo.forRoot()']);
    expect(refs).toEqual([]);
  });
});

describe('resolveComponentScope', () => {
  const childComponent = component({
    path: 'src/app/shared/child.component.ts',
    name: 'ChildComponent',
    selector: 'app-child, [app-child]',
  });

  const highlightDirective = directive({
    path: 'src/app/shared/highlight.directive.ts',
    name: 'HighlightDirective',
    selector: '[appHighlight]',
  });

  const uppercasePipe = pipe({ path: 'src/app/shared/uppercase.pipe.ts', name: 'uppercase' });

  const knownNodes: readonly SelectorTargetNode[] = [childComponent, highlightDirective, uppercasePipe];

  it('resolves a standalone component scope from its own imports array', () => {
    const parentSourceFile = parse(
      `
        import { Component } from '@angular/core';
        import { ChildComponent } from '../shared/child.component';
        import { HighlightDirective } from '../shared/highlight.directive';
        import { UppercasePipe } from '../shared/uppercase.pipe';

        @Component({
          selector: 'app-parent',
          standalone: true,
          imports: [ChildComponent, HighlightDirective, UppercasePipe],
          template: '',
        })
        export class ParentComponent {}
      `,
      'src/app/parent/parent.component.ts',
    );

    const parentComponent = component({
      path: 'src/app/parent/parent.component.ts',
      name: 'ParentComponent',
      selector: 'app-parent',
      standalone: true,
    });

    const scope = resolveComponentScope({
      typescript,
      component: parentComponent,
      componentSourceFile: parentSourceFile,
      knownNodes,
    });

    expect(scope.resolvedBy).toBe('standalone');
    const childMatches = matchSelector(scope, 'app-child');
    expect(childMatches.length).toBeGreaterThan(0);
    for (const match of childMatches) {
      expect(match).toMatchObject({ targetRef: childComponent.id, targetKind: 'Component', confidence: 'inferred' });
    }
    expect(matchSelector(scope, 'appHighlight')[0]).toMatchObject({ targetRef: highlightDirective.id });
  });

  it('resolves an NgModule-declared component scope from the declaring module', () => {
    const moduleSourceFile = parse(
      `
        import { NgModule } from '@angular/core';
        import { ChildComponent } from '../shared/child.component';

        export class PageComponent {}

        @NgModule({ declarations: [PageComponent, ChildComponent] })
        export class PageModule {}
      `,
      'src/app/page/page.module.ts',
    );

    const pageComponent = component({
      path: 'src/app/page/page.module.ts',
      name: 'PageComponent',
      standalone: false,
    });

    const pageModule: NgModuleNode = {
      kind: 'NgModule',
      id: 'src/app/page/page.module.ts#PageModule',
      path: 'src/app/page/page.module.ts',
      name: 'PageModule',
      declarations: ['PageComponent', 'ChildComponent'],
      imports: [],
      exports: [],
      providers: [],
    };

    const scope = resolveComponentScope({
      typescript,
      component: pageComponent,
      ngModules: [pageModule],
      ngModuleSourceFiles: new Map([[pageModule.path, moduleSourceFile]]),
      knownNodes,
    });

    expect(scope.resolvedBy).toBe('ngmodule');
    expect(scope.viaModuleRef).toBe(pageModule.id);
    const childMatches = matchSelector(scope, 'app-child');
    expect(childMatches.length).toBeGreaterThan(0);
    for (const match of childMatches) expect(match.confidence).toBe('inferred');
  });

  it('reports unknown, with no entries, for a standalone component with no source file given', () => {
    const parentComponent = component({ path: 'src/app/parent.component.ts', name: 'ParentComponent', standalone: true });
    const scope = resolveComponentScope({ typescript, component: parentComponent, knownNodes });

    expect(scope.resolvedBy).toBe('unknown');
    expect(scope.entries).toEqual([]);
  });

  it('reports unknown, with no entries, when the declaring NgModule cannot be found', () => {
    const pageComponent = component({ path: 'src/app/page.component.ts', name: 'PageComponent', standalone: false });
    const scope = resolveComponentScope({ typescript, component: pageComponent, ngModules: [], knownNodes });

    expect(scope.resolvedBy).toBe('unknown');
    expect(scope.entries).toEqual([]);
  });

  it('never guesses a selector for a target outside the known nodes', () => {
    const parentSourceFile = parse(
      `
        import { Component } from '@angular/core';
        import { UnknownWidgetModule } from '@third-party/widgets';

        @Component({ selector: 'app-parent', standalone: true, imports: [UnknownWidgetModule], template: '' })
        export class ParentComponent {}
      `,
      'src/app/parent.component.ts',
    );

    const parentComponent = component({ path: 'src/app/parent.component.ts', name: 'ParentComponent', standalone: true });
    const scope = resolveComponentScope({
      typescript,
      component: parentComponent,
      componentSourceFile: parentSourceFile,
      knownNodes,
    });

    expect(scope.entries).toEqual([]);
  });
});

describe('matchSelector', () => {
  it('splits a comma-separated selector into independently matchable tokens', () => {
    const target = component({ path: 'src/app/badge.component.ts', name: 'BadgeComponent', selector: 'app-badge, [app-badge]' });
    const scope = {
      ownerRef: 'src/app/host.component.ts#HostComponent',
      resolvedBy: 'standalone' as const,
      entries: [
        { selector: 'app-badge', targetRef: target.id, targetKind: 'Component' as const, confidence: 'certain' as const },
      ],
    };

    expect(matchSelector(scope, 'app-badge')).toHaveLength(1);
    expect(matchSelector(scope, 'unknown-tag')).toEqual([]);
  });
});
