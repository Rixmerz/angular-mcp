import * as angularCompiler from '@angular/compiler';
import { describe, expect, it } from 'vitest';

import { extractTemplate } from '../../src/indexer/extractors/templates.js';
import type { BindsEdge, UsesInTemplateEdge } from '../../src/graph/model.js';
import type { ComponentScope } from '../../src/indexer/extractors/selectors.js';

const OWNER_REF = 'src/app/widget/widget.component.ts#WidgetComponent';
const OWNER_FILE = 'src/app/widget/widget.component.ts';

function extract(templateSource: string, options: { scope?: ComponentScope; templatePath?: string; inline?: boolean } = {}) {
  return extractTemplate({
    angularCompiler,
    templateSource,
    templatePath: options.templatePath ?? OWNER_FILE,
    inline: options.inline ?? true,
    ownerRef: OWNER_REF,
    ownerFilePath: OWNER_FILE,
    scope: options.scope,
  });
}

function bindsEdges(edges: readonly unknown[]): BindsEdge[] {
  return edges.filter((e): e is BindsEdge => (e as { kind: string }).kind === 'binds');
}

describe('extractTemplate', () => {
  describe('the Template node itself', () => {
    it('builds a Template node with no parse errors for a valid template', () => {
      const { templateNode } = extract('<div>{{ name }}</div>');
      expect(templateNode.kind).toBe('Template');
      expect(templateNode.inline).toBe(true);
      expect(templateNode.parseErrors).toEqual([]);
    });

    it('marks an external template as not inline, at its own path', () => {
      const { templateNode } = extract('<div></div>', { templatePath: 'src/app/widget/widget.component.html', inline: false });
      expect(templateNode.inline).toBe(false);
      expect(templateNode.path).toBe('src/app/widget/widget.component.html');
    });

    it('emits a renders edge from the owning component to the template', () => {
      const { edges, templateNode } = extract('<div></div>');
      const rendersEdge = edges.find((e) => e.kind === 'renders')!;
      expect(rendersEdge.from).toBe(OWNER_REF);
      expect(rendersEdge.to).toBe(templateNode.id);
    });
  });

  describe('R14: a syntax error never aborts extraction', () => {
    it('stores parseErrors for an unterminated binding instead of throwing', () => {
      expect(() => extract('<div [foo]="bar</div>')).not.toThrow();

      const { templateNode } = extract('<div [foo]="bar</div>');
      expect(templateNode.parseErrors.length).toBeGreaterThan(0);
      expect(templateNode.parseErrors[0]?.message).toBeTruthy();
      expect(templateNode.parseErrors[0]?.line).toBeGreaterThan(0);
    });

    it('stores parseErrors for a mismatched closing tag', () => {
      const { templateNode } = extract('<div><span></div>');
      expect(templateNode.parseErrors.length).toBeGreaterThan(0);
    });

    it('still returns a well-formed node when the compiler throws synchronously', () => {
      const throwingCompiler = {
        parseTemplate: () => {
          throw new Error('boom');
        },
      };

      const result = extractTemplate({
        angularCompiler: throwingCompiler,
        templateSource: '<div></div>',
        templatePath: OWNER_FILE,
        inline: true,
        ownerRef: OWNER_REF,
        ownerFilePath: OWNER_FILE,
      });

      expect(result.templateNode.parseErrors).toEqual([{ message: 'boom' }]);
      expect(result.edges).toEqual([]);
    });

    it('still walks the partially-parsed nodes of a template with an error elsewhere', () => {
      // The first, well-formed interpolation should still produce a binding even
      // though a later element on the same template has a broken expression.
      const { edges, templateNode } = extract('<div>{{ name }}</div><input [value]="bad(">');
      expect(templateNode.parseErrors.length).toBeGreaterThan(0);
      const binds = bindsEdges(edges);
      expect(binds.some((e) => e.memberName === 'name' && e.bindingKind === 'interpolation')).toBe(true);
    });
  });

  describe('binding classification', () => {
    it('classifies an interpolation', () => {
      const { edges } = extract('<div>{{ title }}</div>');
      const binds = bindsEdges(edges);
      expect(binds).toHaveLength(1);
      expect(binds[0]).toMatchObject({ bindingKind: 'interpolation', memberName: 'title', targetKind: 'property' });
    });

    it('classifies a property binding', () => {
      const { edges } = extract('<input [value]="title">');
      const binds = bindsEdges(edges);
      expect(binds).toHaveLength(1);
      expect(binds[0]).toMatchObject({ bindingKind: 'property', memberName: 'title', targetKind: 'property' });
    });

    it('classifies an event binding, resolving the handler as a method', () => {
      const { edges } = extract('<button (click)="save()">Save</button>');
      const binds = bindsEdges(edges);
      expect(binds).toHaveLength(1);
      expect(binds[0]).toMatchObject({ bindingKind: 'event', memberName: 'save', targetKind: 'method' });
    });

    it('classifies a two-way binding on both its property and event side', () => {
      const { edges } = extract('<input [(ngModel)]="title">');
      const binds = bindsEdges(edges);
      expect(binds).toHaveLength(2);
      expect(binds.every((e) => e.bindingKind === 'two-way')).toBe(true);
      expect(binds.every((e) => e.memberName === 'title')).toBe(true);
    });

    it('classifies a native attribute/class/style binding as attribute, not property', () => {
      const { edges } = extract('<div [attr.data-id]="itemId" [class.active]="isActive" [style.color]="color"></div>');
      const binds = bindsEdges(edges);
      expect(binds).toHaveLength(3);
      expect(binds.every((e) => e.bindingKind === 'attribute')).toBe(true);
      expect(binds.map((e) => e.memberName).sort()).toEqual(['color', 'isActive', 'itemId']);
    });

    it('classifies a legacy structural directive (*ngIf) as control-flow', () => {
      const { edges } = extract('<div *ngIf="isVisible">hi</div>');
      const binds = bindsEdges(edges);
      expect(binds).toHaveLength(1);
      expect(binds[0]).toMatchObject({ bindingKind: 'control-flow', memberName: 'isVisible' });
    });

    it('classifies *ngFor, binding to the iterated collection member', () => {
      const { edges } = extract('<li *ngFor="let item of items">{{ item }}</li>');
      const binds = bindsEdges(edges);
      expect(binds.some((e) => e.bindingKind === 'control-flow' && e.memberName === 'items')).toBe(true);
      // The loop variable itself is local, never reported as a component member.
      expect(binds.some((e) => e.memberName === 'item')).toBe(false);
    });

    it('classifies the new @if control flow syntax', () => {
      const { edges } = extract('@if (isVisible) { <div>hi</div> } @else { <div>bye</div> }');
      const binds = bindsEdges(edges);
      expect(binds).toHaveLength(1);
      expect(binds[0]).toMatchObject({ bindingKind: 'control-flow', memberName: 'isVisible' });
    });

    it('classifies the new @for control flow syntax and scopes its loop/context variables', () => {
      const { edges } = extract('@for (item of items; track item.id) { {{ item }}-{{ $index }} }');
      const binds = bindsEdges(edges);
      expect(binds.some((e) => e.bindingKind === 'control-flow' && e.memberName === 'items')).toBe(true);
      expect(binds.some((e) => e.memberName === 'item')).toBe(false);
      expect(binds.some((e) => e.memberName === '$index')).toBe(false);
    });

    it('classifies the new @switch control flow syntax, including each @case', () => {
      const { edges } = extract('@switch (status) { @case (active) { <div>on</div> } @default { <div>off</div> } }');
      const binds = bindsEdges(edges);
      const controlFlowMembers = binds.filter((e) => e.bindingKind === 'control-flow').map((e) => e.memberName);
      expect(controlFlowMembers).toContain('status');
      expect(controlFlowMembers).toContain('active');
    });

    it('scopes an @if...as alias so it is never reported as a component member', () => {
      const { edges } = extract('@if (getUser(); as user) { {{ user.name }} }');
      const binds = bindsEdges(edges);
      expect(binds.some((e) => e.memberName === 'getUser' && e.targetKind === 'method')).toBe(true);
      expect(binds.some((e) => e.memberName === 'user')).toBe(false);
    });

    it('scopes a @let declaration for the siblings that follow it, not for its own initializer', () => {
      const { edges } = extract('@let doubled = count; {{ doubled }}');
      const binds = bindsEdges(edges);
      // `doubled`'s own initializer binds to the real component member `count`.
      expect(binds.some((e) => e.memberName === 'count' && e.bindingKind === 'control-flow')).toBe(true);
      // The later interpolation reads the local `doubled`, not a component member.
      expect(binds.some((e) => e.memberName === 'doubled')).toBe(false);
    });

    it('never reports $event as a component member', () => {
      const { edges } = extract('<input (input)="onInput($event)">');
      const binds = bindsEdges(edges);
      expect(binds).toHaveLength(1);
      expect(binds[0]).toMatchObject({ memberName: 'onInput', targetKind: 'method' });
    });

    it('resolves the root of a nested property chain, not the leaf', () => {
      const { edges } = extract('<div>{{ user.profile.displayName }}</div>');
      const binds = bindsEdges(edges);
      expect(binds).toHaveLength(1);
      expect(binds[0]?.memberName).toBe('user');
    });

    it('collects every member referenced in a compound expression', () => {
      const { edges } = extract('<div>{{ firstName + " " + lastName }}</div>');
      const binds = bindsEdges(edges);
      expect(binds.map((e) => e.memberName).sort()).toEqual(['firstName', 'lastName']);
    });

    it('emits no binds edge for an expression with no component member (a literal)', () => {
      const { edges } = extract('<div>{{ 42 }}</div>');
      expect(bindsEdges(edges)).toEqual([]);
    });

    it('upgrades targetKind to signal when told the member is a known signal', () => {
      const result = extractTemplate({
        angularCompiler,
        templateSource: '<div>{{ count() }}</div>',
        templatePath: OWNER_FILE,
        inline: true,
        ownerRef: OWNER_REF,
        ownerFilePath: OWNER_FILE,
        memberKinds: new Map([['count', 'signal']]),
      });

      const binds = bindsEdges(result.edges);
      expect(binds[0]).toMatchObject({ memberName: 'count', targetKind: 'signal' });
    });
  });

  describe('selector resolution against the component scope (R4)', () => {
    const childComponentRef = 'src/app/shared/child.component.ts#ChildComponent';
    const highlightDirectiveRef = 'src/app/shared/highlight.directive.ts#HighlightDirective';
    const uppercasePipeRef = 'src/app/shared/uppercase.pipe.ts#UppercasePipe';

    const scope: ComponentScope = {
      ownerRef: OWNER_REF,
      resolvedBy: 'standalone',
      entries: [
        { selector: 'app-child', targetRef: childComponentRef, targetKind: 'Component', confidence: 'certain' },
        { selector: 'appHighlight', targetRef: highlightDirectiveRef, targetKind: 'Directive', confidence: 'inferred' },
        { selector: 'uppercase', targetRef: uppercasePipeRef, targetKind: 'Pipe', confidence: 'certain' },
      ],
    };

    function usesInTemplateEdges(edges: readonly unknown[]): UsesInTemplateEdge[] {
      return edges.filter((e): e is UsesInTemplateEdge => (e as { kind: string }).kind === 'uses_in_template');
    }

    it('resolves a custom element tag against the standalone scope', () => {
      const { edges } = extract('<app-child></app-child>', { scope });
      const uses = usesInTemplateEdges(edges);
      expect(uses).toHaveLength(1);
      expect(uses[0]).toMatchObject({ to: childComponentRef, selector: 'app-child', confidence: 'certain' });
    });

    it('resolves an attribute directive selector', () => {
      const { edges } = extract('<div appHighlight></div>', { scope });
      const uses = usesInTemplateEdges(edges);
      expect(uses).toHaveLength(1);
      expect(uses[0]).toMatchObject({ to: highlightDirectiveRef, selector: 'appHighlight', confidence: 'inferred' });
    });

    it('resolves a pipe used in an expression', () => {
      const { edges } = extract('<div>{{ name | uppercase }}</div>', { scope });
      const uses = usesInTemplateEdges(edges);
      expect(uses).toHaveLength(1);
      expect(uses[0]).toMatchObject({ to: uppercasePipeRef, selector: 'uppercase' });
    });

    it('emits no uses_in_template edge for a tag not present in scope', () => {
      const { edges } = extract('<some-other-widget></some-other-widget>', { scope });
      expect(usesInTemplateEdges(edges)).toEqual([]);
    });

    it('never emits uses_in_template edges when no scope is given at all', () => {
      const { edges } = extract('<app-child></app-child>');
      expect(usesInTemplateEdges(edges)).toEqual([]);
    });
  });
});
