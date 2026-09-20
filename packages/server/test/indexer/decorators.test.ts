import * as typescript from 'typescript';
import { describe, expect, it } from 'vitest';

import { extractDecorators, standaloneByDefaultFor } from '../../src/indexer/extractors/decorators.js';
import type { ComponentNode, DirectiveNode, PipeNode, ServiceNode } from '../../src/graph/model.js';

function parse(source: string, fileName = 'src/app/example.component.ts'): typescript.SourceFile {
  return typescript.createSourceFile(fileName, source, typescript.ScriptTarget.Latest, true, typescript.ScriptKind.TS);
}

describe('extractDecorators — @Component', () => {
  it('extracts selector, standalone, changeDetection, templateUrl and styleUrls', () => {
    const sourceFile = parse(`
      import { ChangeDetectionStrategy, Component } from '@angular/core';

      @Component({
        selector: 'app-user-list',
        standalone: true,
        changeDetection: ChangeDetectionStrategy.OnPush,
        templateUrl: './user-list.component.html',
        styleUrls: ['./user-list.component.scss', './shared.scss'],
      })
      export class UserListComponent {}
    `, 'src/app/user-list.component.ts');

    const { nodes } = extractDecorators(typescript, sourceFile, 'src/app/user-list.component.ts');
    expect(nodes).toHaveLength(1);

    const component = nodes[0] as ComponentNode;
    expect(component.kind).toBe('Component');
    expect(component.id).toBe('src/app/user-list.component.ts#UserListComponent');
    expect(component.selector).toBe('app-user-list');
    expect(component.standalone).toBe(true);
    expect(component.changeDetection).toBe('OnPush');
    expect(component.templatePath).toBe('src/app/user-list.component.html');
    expect(component.inlineTemplate).toBe(false);
    expect(component.stylePaths).toEqual(['src/app/user-list.component.scss', 'src/app/shared.scss']);
  });

  it('defaults standalone to true and changeDetection to Default when omitted, and records an inline template', () => {
    const sourceFile = parse(`
      import { Component } from '@angular/core';

      @Component({ selector: 'app-inline', template: '<p>hi</p>' })
      export class InlineComponent {}
    `);

    const { nodes } = extractDecorators(typescript, sourceFile, 'src/app/example.component.ts');
    const component = nodes[0] as ComponentNode;

    expect(component.standalone).toBe(true);
    expect(component.changeDetection).toBe('Default');
    expect(component.templatePath).toBeUndefined();
    expect(component.inlineTemplate).toBe(true);
    expect(component.stylePaths).toEqual([]);
  });

  it('respects an explicit standalone: false', () => {
    const sourceFile = parse(`
      import { Component } from '@angular/core';

      @Component({ selector: 'app-legacy', standalone: false, template: '' })
      export class LegacyComponent {}
    `);

    const { nodes } = extractDecorators(typescript, sourceFile, 'src/app/example.component.ts');
    expect((nodes[0] as ComponentNode).standalone).toBe(false);
  });

  it('extracts @Input()/@Output() decorator bindings with alias and required', () => {
    const sourceFile = parse(`
      import { Component, EventEmitter, Input, Output } from '@angular/core';

      @Component({ selector: 'app-user-list', template: '' })
      export class UserListComponent {
        @Input() pageSize: number = 10;
        @Input('userId') id!: string;
        @Input({ required: true, alias: 'items' }) list!: string[];
        @Output() selectionChange = new EventEmitter<string>();
        @Output('closed') closeRequested = new EventEmitter<void>();
      }
    `);

    const { nodes } = extractDecorators(typescript, sourceFile, 'src/app/example.component.ts');
    const component = nodes[0] as ComponentNode;

    const pageSize = component.inputs.find((i) => i.name === 'pageSize')!;
    expect(pageSize.alias).toBeUndefined();
    expect(pageSize.required).toBe(false);
    expect(pageSize.isSignal).toBe(false);
    expect(pageSize.typeText).toBe('number');

    const id = component.inputs.find((i) => i.name === 'id')!;
    expect(id.alias).toBe('userId');
    expect(id.required).toBe(false);

    const list = component.inputs.find((i) => i.name === 'list')!;
    expect(list.alias).toBe('items');
    expect(list.required).toBe(true);

    const selectionChange = component.outputs.find((o) => o.name === 'selectionChange')!;
    expect(selectionChange.alias).toBeUndefined();
    expect(selectionChange.typeText).toBe('string');
    expect(selectionChange.isSignal).toBe(false);

    const closeRequested = component.outputs.find((o) => o.name === 'closeRequested')!;
    expect(closeRequested.alias).toBe('closed');
    expect(closeRequested.typeText).toBe('void');
  });

  it('extracts signal-based input(), input.required(), model() and output() as isSignal bindings', () => {
    const sourceFile = parse(`
      import { Component, input, model, output } from '@angular/core';

      @Component({ selector: 'app-user-list', template: '' })
      export class UserListComponent {
        readonly pageTitle = input('Users');
        readonly userId = input.required<number>();
        readonly currentPage = model(1);
        readonly selected = output<string>();
      }
    `);

    const { nodes } = extractDecorators(typescript, sourceFile, 'src/app/example.component.ts');
    const component = nodes[0] as ComponentNode;

    const pageTitle = component.inputs.find((i) => i.name === 'pageTitle')!;
    expect(pageTitle.isSignal).toBe(true);
    expect(pageTitle.required).toBe(false);

    const userId = component.inputs.find((i) => i.name === 'userId')!;
    expect(userId.isSignal).toBe(true);
    expect(userId.required).toBe(true);
    expect(userId.typeText).toBe('number');

    // model() is both an input and an output.
    expect(component.inputs.some((i) => i.name === 'currentPage')).toBe(true);
    expect(component.outputs.some((o) => o.name === 'currentPage')).toBe(true);

    const selected = component.outputs.find((o) => o.name === 'selected')!;
    expect(selected.isSignal).toBe(true);

    expect(component.signals).toContain('src/app/example.component.ts#UserListComponent.pageTitle');
    expect(component.signals).toContain('src/app/example.component.ts#UserListComponent.userId');
    expect(component.signals).toContain('src/app/example.component.ts#UserListComponent.currentPage');
    expect(component.signals).toContain('src/app/example.component.ts#UserListComponent.selected');
  });

  it('extracts lifecycle hooks and host bindings from metadata and member decorators', () => {
    const sourceFile = parse(`
      import { Component, HostBinding, HostListener } from '@angular/core';

      @Component({
        selector: 'app-user-list',
        template: '',
        host: { '[class.busy]': 'isBusy' },
      })
      export class UserListComponent {
        @HostBinding('class.active') isActive = false;
        @HostListener('click', ['$event']) onClick(event: Event) {}

        ngOnInit(): void {}
        ngOnDestroy(): void {}
      }
    `);

    const { nodes } = extractDecorators(typescript, sourceFile, 'src/app/example.component.ts');
    const component = nodes[0] as ComponentNode;

    expect(component.lifecycleHooks).toEqual(['ngOnInit', 'ngOnDestroy']);
    expect(component.hostBindings).toContain("[class.busy]: 'isBusy'");
    expect(component.hostBindings).toContain('class.active: isActive');
    expect(component.hostBindings).toContain("(click): onClick('$event')");
  });
});

describe('extractDecorators — @Directive', () => {
  it('extracts selector, standalone, inputs/outputs and hostDirectives', () => {
    const sourceFile = parse(`
      import { Directive, Input } from '@angular/core';

      class HighlightDirective {}

      @Directive({
        selector: '[appTooltip]',
        hostDirectives: [HighlightDirective, { directive: HighlightDirective, inputs: ['color'] }],
      })
      export class TooltipDirective {
        @Input() text = '';
      }
    `);

    const { nodes } = extractDecorators(typescript, sourceFile, 'src/app/example.component.ts');
    expect(nodes).toHaveLength(1);

    const directive = nodes[0] as DirectiveNode;
    expect(directive.kind).toBe('Directive');
    expect(directive.selector).toBe('[appTooltip]');
    expect(directive.standalone).toBe(true);
    expect(directive.inputs).toHaveLength(1);
    expect(directive.inputs[0]!.name).toBe('text');
    expect(directive.hostDirectives).toHaveLength(2);
    expect(directive.hostDirectives.every((ref) => ref.specifier === 'HighlightDirective')).toBe(true);
    expect(directive.hostDirectives.every((ref) => ref.confidence === 'certain')).toBe(true);
  });
});

describe('extractDecorators — @Pipe', () => {
  it('names the node after the class and keeps the registered pipe name in pipeName', () => {
    const sourceFile = parse(`
      import { Pipe, PipeTransform } from '@angular/core';

      @Pipe({ name: 'truncate' })
      export class TruncatePipe implements PipeTransform {
        transform(value: string): string { return value; }
      }
    `);

    const { nodes } = extractDecorators(typescript, sourceFile, 'src/app/example.component.ts');
    const pipe = nodes[0] as PipeNode;

    expect(pipe.kind).toBe('Pipe');
    expect(pipe.id).toBe('src/app/example.component.ts#TruncatePipe');
    // `name` is the class name for every node kind, so angular_find_symbol
    // finds a pipe by the name it is written under. The template-facing name
    // is the pipe's selector equivalent and lives in `pipeName`.
    expect(pipe.name).toBe('TruncatePipe');
    expect(pipe.pipeName).toBe('truncate');
    expect(pipe.standalone).toBe(true);
    expect(pipe.pure).toBe(true);
  });

  it('respects pure: false', () => {
    const sourceFile = parse(`
      import { Pipe } from '@angular/core';

      @Pipe({ name: 'liveFilter', pure: false })
      export class LiveFilterPipe {}
    `);

    const { nodes } = extractDecorators(typescript, sourceFile, 'src/app/example.component.ts');
    expect((nodes[0] as PipeNode).pure).toBe(false);
  });
});

describe('extractDecorators — @Injectable', () => {
  it('extracts providedIn and marks isInjectable true', () => {
    const sourceFile = parse(`
      import { Injectable } from '@angular/core';

      @Injectable({ providedIn: 'root' })
      export class UserService {}
    `);

    const { nodes } = extractDecorators(typescript, sourceFile, 'src/app/example.component.ts');
    const service = nodes[0] as ServiceNode;

    expect(service.kind).toBe('Service');
    expect(service.providedIn).toBe('root');
    expect(service.isInjectable).toBe(true);
  });

  it('defaults providedIn to none for a bare @Injectable()', () => {
    const sourceFile = parse(`
      import { Injectable } from '@angular/core';

      @Injectable()
      export class ScopedService {}
    `);

    const { nodes } = extractDecorators(typescript, sourceFile, 'src/app/example.component.ts');
    expect((nodes[0] as ServiceNode).providedIn).toBe('none');
  });
});

describe('extractDecorators — no decorator', () => {
  it('produces no node for an undecorated class', () => {
    const sourceFile = parse(`
      export class PlainHelper {}
    `);

    const { nodes } = extractDecorators(typescript, sourceFile, 'src/app/example.component.ts');
    expect(nodes).toEqual([]);
  });
});

describe('extractDecorators — the standalone default', () => {
  const componentSource = `
    import { Component } from '@angular/core';

    @Component({ selector: 'app-classic', templateUrl: './classic.component.html' })
    export class ClassicComponent {}
  `;

  it('treats an omitted standalone flag as false before Angular 19', () => {
    const sourceFile = parse(componentSource);

    const { nodes } = extractDecorators(typescript, sourceFile, 'src/app/classic.component.ts', {
      standaloneByDefault: standaloneByDefaultFor(18),
    });

    expect((nodes[0] as ComponentNode).standalone).toBe(false);
  });

  it('treats an omitted standalone flag as true from Angular 19 on', () => {
    const sourceFile = parse(componentSource);

    const { nodes } = extractDecorators(typescript, sourceFile, 'src/app/classic.component.ts', {
      standaloneByDefault: standaloneByDefaultFor(19),
    });

    expect((nodes[0] as ComponentNode).standalone).toBe(true);
  });

  it('still honors an explicit flag, whichever way the default points', () => {
    const sourceFile = parse(`
      import { Component } from '@angular/core';

      @Component({ selector: 'app-explicit', standalone: true, template: '' })
      export class ExplicitComponent {}
    `);

    const { nodes } = extractDecorators(typescript, sourceFile, 'src/app/explicit.component.ts', {
      standaloneByDefault: standaloneByDefaultFor(18),
    });

    expect((nodes[0] as ComponentNode).standalone).toBe(true);
  });

  it('assumes a modern default when the Angular version cannot be read', () => {
    expect(standaloneByDefaultFor(undefined)).toBe(true);
  });
});
