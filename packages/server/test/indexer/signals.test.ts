import * as typescript from 'typescript';
import { describe, expect, it } from 'vitest';

import { extractSignals } from '../../src/indexer/extractors/signals.js';
import type { ObservableNode, SignalNode } from '../../src/graph/model.js';

function parse(source: string, fileName = 'src/app/example.component.ts'): typescript.SourceFile {
  return typescript.createSourceFile(fileName, source, typescript.ScriptTarget.Latest, true, typescript.ScriptKind.TS);
}

function isSignal(node: SignalNode | ObservableNode): node is SignalNode {
  return node.kind === 'Signal';
}

describe('extractSignals', () => {
  it('detects signal, computed and linkedSignal fields with their initial value text', () => {
    const sourceFile = parse(`
      import { Component, computed, linkedSignal, signal } from '@angular/core';

      @Component({ selector: 'app-example' })
      export class ExampleComponent {
        readonly count = signal(0);
        readonly doubled = computed(() => this.count() * 2);
        readonly clamped = linkedSignal(() => this.count());
      }
    `);

    const nodes = extractSignals(typescript, sourceFile, 'src/app/example.component.ts');
    const byName = new Map(nodes.map((node) => [node.name, node]));

    const count = byName.get('count') as SignalNode;
    expect(count.kind).toBe('Signal');
    expect(count.signalKind).toBe('signal');
    expect(count.required).toBe(false);
    expect(count.initialValueText).toBe('0');
    expect(count.ownerRef).toBe('src/app/example.component.ts#ExampleComponent');
    expect(count.id).toBe('src/app/example.component.ts#ExampleComponent.count');

    const doubled = byName.get('doubled') as SignalNode;
    expect(doubled.signalKind).toBe('computed');

    const clamped = byName.get('clamped') as SignalNode;
    expect(clamped.signalKind).toBe('linkedSignal');
  });

  it('detects input(), input.required() and records the declared/type-argument typeText', () => {
    const sourceFile = parse(`
      import { Component, input } from '@angular/core';

      @Component({ selector: 'app-example' })
      export class ExampleComponent {
        readonly pageTitle = input('Users');
        readonly orderId = input.required<number>();
        readonly label: string = input('x');
      }
    `);

    const nodes = extractSignals(typescript, sourceFile, 'src/app/example.component.ts');
    const byName = new Map(nodes.map((node) => [node.name, node as SignalNode]));

    const pageTitle = byName.get('pageTitle')!;
    expect(pageTitle.signalKind).toBe('input');
    expect(pageTitle.required).toBe(false);
    expect(pageTitle.initialValueText).toBe("'Users'");

    const orderId = byName.get('orderId')!;
    expect(orderId.signalKind).toBe('input');
    expect(orderId.required).toBe(true);
    expect(orderId.typeText).toBe('number');
    expect(orderId.initialValueText).toBeUndefined();

    const label = byName.get('label')!;
    expect(label.typeText).toBe('string');
  });

  it('detects model, output, viewChild, viewChildren and contentChild', () => {
    const sourceFile = parse(`
      import { Component, ElementRef, contentChild, model, output, viewChild, viewChildren } from '@angular/core';

      @Component({ selector: 'app-example' })
      export class ExampleComponent {
        readonly currentPage = model(1);
        readonly selected = output<number>();
        readonly paginatorEl = viewChild<ElementRef<HTMLDivElement>>('paginator');
        readonly rows = viewChildren('row');
        readonly header = contentChild('header');
      }
    `);

    const nodes = extractSignals(typescript, sourceFile, 'src/app/example.component.ts');
    const byName = new Map(nodes.map((node) => [node.name, node as SignalNode]));

    expect(byName.get('currentPage')!.signalKind).toBe('model');
    expect(byName.get('currentPage')!.initialValueText).toBe('1');

    expect(byName.get('selected')!.signalKind).toBe('output');

    const paginatorEl = byName.get('paginatorEl')!;
    expect(paginatorEl.signalKind).toBe('viewChild');
    expect(paginatorEl.typeText).toBe('ElementRef<HTMLDivElement>');
    expect(paginatorEl.initialValueText).toBe("'paginator'");

    expect(byName.get('rows')!.signalKind).toBe('viewChildren');
    expect(byName.get('header')!.signalKind).toBe('contentChild');
  });

  it('detects toSignal and reads initialValue from the options object, not the observable argument', () => {
    const sourceFile = parse(`
      import { Component, inject } from '@angular/core';
      import { toSignal } from '@angular/core/rxjs-interop';
      import { UserService } from '../../core/services/user.service';

      @Component({ selector: 'app-example' })
      export class ExampleComponent {
        private readonly userService = inject(UserService);
        readonly users = toSignal(this.userService.getUsers(), { initialValue: [] });
        readonly maybeUsers = toSignal(this.userService.getUsers());
      }
    `);

    const nodes = extractSignals(typescript, sourceFile, 'src/app/example.component.ts');
    const byName = new Map(nodes.map((node) => [node.name, node as SignalNode]));

    const users = byName.get('users')!;
    expect(users.signalKind).toBe('toSignal');
    expect(users.initialValueText).toBe('[]');

    const maybeUsers = byName.get('maybeUsers')!;
    expect(maybeUsers.signalKind).toBe('toSignal');
    expect(maybeUsers.initialValueText).toBeUndefined();
  });

  it('detects resource and httpResource', () => {
    const sourceFile = parse(`
      import { Component, resource } from '@angular/core';
      import { httpResource } from '@angular/common/http';

      @Component({ selector: 'app-example' })
      export class ExampleComponent {
        readonly userId = resource({
          request: () => this.id(),
          loader: async ({ request }) => fetch(\`/users/\${request}\`).then((r) => r.json()),
        });
        readonly userData = httpResource<unknown>(() => \`/api/users/\${this.id()}\`);
      }
    `);

    const nodes = extractSignals(typescript, sourceFile, 'src/app/example.component.ts');
    const byName = new Map(nodes.map((node) => [node.name, node as SignalNode]));

    expect(byName.get('userId')!.signalKind).toBe('resource');
    expect(byName.get('userData')!.signalKind).toBe('httpResource');
    expect(byName.get('userData')!.typeText).toBe('unknown');
  });

  it('detects declared Observable, Subject and BehaviorSubject fields without following pipe/switchMap', () => {
    const sourceFile = parse(`
      import { Injectable } from '@angular/core';
      import { BehaviorSubject, Observable, Subject, switchMap } from 'rxjs';

      @Injectable({ providedIn: 'root' })
      export class ExampleService {
        readonly typed: Observable<number> = someSource();
        readonly untypedSubject = new Subject<string>();
        readonly state = new BehaviorSubject<number>(0);

        derived(): Observable<number> {
          return this.typed.pipe(switchMap(() => this.state));
        }
      }
    `, 'src/app/example.service.ts');

    const nodes = extractSignals(typescript, sourceFile, 'src/app/example.service.ts');
    const observables = nodes.filter((node): node is ObservableNode => node.kind === 'Observable');
    const byName = new Map(observables.map((node) => [node.name, node]));

    expect(byName.size).toBe(3);

    const typed = byName.get('typed')!;
    expect(typed.typeText).toBe('Observable<number>');
    expect(typed.ownerRef).toBe('src/app/example.service.ts#ExampleService');
    expect(typed.id).toBe('src/app/example.service.ts#ExampleService.typed');

    expect(byName.get('untypedSubject')!.typeText).toBe('Subject<string>');
    expect(byName.get('state')!.typeText).toBe('BehaviorSubject<number>');

    // `derived()` returns an Observable but is a method, not a field: no node for it.
    expect(nodes.some((node) => node.name === 'derived')).toBe(false);
    // No node/edge for anything reached only via pipe/switchMap (section 13: out of scope for v1).
    expect(nodes.every((node) => !isSignal(node))).toBe(true);
  });

  it('ignores calls to local functions that share a name with an Angular signal API but are not imported from @angular/*', () => {
    const sourceFile = parse(`
      function signal(value: number): number {
        return value;
      }

      export class NotAComponent {
        readonly count = signal(5);
      }
    `);

    const nodes = extractSignals(typescript, sourceFile, 'src/app/not-a-component.ts');
    expect(nodes).toEqual([]);
  });
});
