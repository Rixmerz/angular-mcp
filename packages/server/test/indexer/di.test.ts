import * as typescript from 'typescript';
import { describe, expect, it } from 'vitest';

import { extractInjections } from '../../src/indexer/extractors/di.js';

function parse(source: string, fileName = 'src/app/example.component.ts'): typescript.SourceFile {
  return typescript.createSourceFile(fileName, source, typescript.ScriptTarget.Latest, true, typescript.ScriptKind.TS);
}

describe('extractInjections', () => {
  it('detects constructor injection of a service imported from a relative specifier', () => {
    const sourceFile = parse(`
      import { Component } from '@angular/core';
      import { UserService } from '../../core/services/user.service';

      @Component({ selector: 'app-user-list' })
      export class UserListComponent {
        constructor(private userService: UserService) {}
      }
    `);

    const edges = extractInjections(typescript, sourceFile, 'src/app/example.component.ts');
    expect(edges).toHaveLength(1);

    const edge = edges[0]!;
    expect(edge.kind).toBe('injects');
    expect(edge.from).toBe('src/app/example.component.ts#UserListComponent');
    expect(edge.to).toBe('core/services/user.service.ts#UserService');
    expect(edge.via).toBe('constructor');
    expect(edge.optional).toBe(false);
    expect(edge.confidence).toBe('inferred');
  });

  it('detects constructor injection of a service declared in the same file as certain', () => {
    const sourceFile = parse(`
      import { Injectable } from '@angular/core';

      @Injectable({ providedIn: 'root' })
      export class LoggerService {}

      export class UserListComponent {
        constructor(private logger: LoggerService) {}
      }
    `);

    const edges = extractInjections(typescript, sourceFile, 'src/app/example.component.ts');
    const edge = edges.find((e) => e.from === 'src/app/example.component.ts#UserListComponent')!;

    expect(edge.to).toBe('src/app/example.component.ts#LoggerService');
    expect(edge.confidence).toBe('certain');
    expect(edge.via).toBe('constructor');
  });

  it('marks optional: true for a constructor parameter decorated with @Optional', () => {
    const sourceFile = parse(`
      import { Optional } from '@angular/core';

      export class AnalyticsService {}

      export class UserListComponent {
        constructor(@Optional() private analytics: AnalyticsService) {}
      }
    `);

    const edges = extractInjections(typescript, sourceFile, 'src/app/example.component.ts');
    const edge = edges[0]!;

    expect(edge.optional).toBe(true);
    expect(edge.to).toBe('src/app/example.component.ts#AnalyticsService');
    expect(edge.via).toBe('constructor');
  });

  it('resolves the token from @Inject(TOKEN), not the declared parameter type', () => {
    const sourceFile = parse(`
      import { Inject, InjectionToken } from '@angular/core';

      export const API_URL = new InjectionToken<string>('api_url');

      export class UserListComponent {
        constructor(@Inject(API_URL) private apiUrl: string) {}
      }
    `);

    const edges = extractInjections(typescript, sourceFile, 'src/app/example.component.ts');
    const edge = edges[0]!;

    expect(edge.to).toBe('src/app/example.component.ts#API_URL');
    expect(edge.confidence).toBe('certain');
    expect(edge.optional).toBe(false);
    expect(edge.via).toBe('constructor');
  });

  it('combines @Optional and @Inject(TOKEN) on the same parameter', () => {
    const sourceFile = parse(`
      import { Inject, Optional } from '@angular/core';

      export const FEATURE_FLAG = 'feature-flag-token';

      export class UserListComponent {
        constructor(@Optional() @Inject(FEATURE_FLAG) private flag: unknown) {}
      }
    `);

    const edges = extractInjections(typescript, sourceFile, 'src/app/example.component.ts');
    const edge = edges[0]!;

    expect(edge.optional).toBe(true);
    expect(edge.to).toBe('src/app/example.component.ts#FEATURE_FLAG');
  });

  it('detects field injection via inject(), resolved as certain for a same-file class', () => {
    const sourceFile = parse(`
      import { inject } from '@angular/core';

      export class UserService {}

      export class UserListComponent {
        private readonly userService = inject(UserService);
      }
    `);

    const edges = extractInjections(typescript, sourceFile, 'src/app/example.component.ts');
    expect(edges).toHaveLength(1);

    const edge = edges[0]!;
    expect(edge.via).toBe('inject');
    expect(edge.to).toBe('src/app/example.component.ts#UserService');
    expect(edge.confidence).toBe('certain');
    expect(edge.optional).toBe(false);
  });

  it('marks optional: true for inject(TOKEN, { optional: true })', () => {
    const sourceFile = parse(`
      import { inject, InjectionToken } from '@angular/core';

      export const APP_CONFIG = new InjectionToken<{ apiUrl: string }>('app_config');

      export class UserListComponent {
        private readonly config = inject(APP_CONFIG, { optional: true });
      }
    `);

    const edges = extractInjections(typescript, sourceFile, 'src/app/example.component.ts');
    const edge = edges[0]!;

    expect(edge.via).toBe('inject');
    expect(edge.to).toBe('src/app/example.component.ts#APP_CONFIG');
    expect(edge.optional).toBe(true);
  });

  it('does not mark optional when inject() options omit it or set it to false', () => {
    const sourceFile = parse(`
      import { inject } from '@angular/core';

      export class UserService {}

      export class UserListComponent {
        private readonly a = inject(UserService, {});
        private readonly b = inject(UserService, { optional: false });
      }
    `);

    const edges = extractInjections(typescript, sourceFile, 'src/app/example.component.ts');
    expect(edges).toHaveLength(2);
    expect(edges.every((edge) => edge.optional === false)).toBe(true);
  });

  it('falls back to unknown confidence for a token imported from a non-relative package', () => {
    const sourceFile = parse(`
      import { HttpClient } from '@angular/common/http';

      export class UserListComponent {
        constructor(private http: HttpClient) {}
      }
    `);

    const edges = extractInjections(typescript, sourceFile, 'src/app/example.component.ts');
    const edge = edges[0]!;

    expect(edge.to).toBe('src/app/example.component.ts#HttpClient');
    expect(edge.confidence).toBe('unknown');
  });

  it('ignores constructor parameters without a resolvable identifier type and without @Inject', () => {
    const sourceFile = parse(`
      export class UserListComponent {
        constructor(private label: string, private count: number) {}
      }
    `);

    const edges = extractInjections(typescript, sourceFile, 'src/app/example.component.ts');
    expect(edges).toEqual([]);
  });

  it('combines constructor and inject() injections for the same class', () => {
    const sourceFile = parse(`
      import { inject } from '@angular/core';

      export class UserService {}
      export class LoggerService {}

      export class UserListComponent {
        private readonly logger = inject(LoggerService);
        constructor(private userService: UserService) {}
      }
    `);

    const edges = extractInjections(typescript, sourceFile, 'src/app/example.component.ts');
    expect(edges).toHaveLength(2);

    const viaKinds = edges.map((edge) => edge.via).sort();
    expect(viaKinds).toEqual(['constructor', 'inject']);
    expect(edges.every((edge) => edge.from === 'src/app/example.component.ts#UserListComponent')).toBe(true);
  });
});
