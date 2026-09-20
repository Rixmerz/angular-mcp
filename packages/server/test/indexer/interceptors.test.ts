/**
 * Tests for the interceptor extractor.
 *
 * The two registration styles are Angular's, not ours, so both are pinned
 * here: the functional one a standalone app uses, and the HTTP_INTERCEPTORS
 * multi-provider an NgModule app uses. The confidence ladder is pinned too,
 * because a registration that names a symbol in another file is resolved with
 * a path heuristic that is never checked against disk (P4).
 */

import * as typescript from 'typescript';
import { describe, expect, it } from 'vitest';

import type { InterceptorNode } from '../../src/graph/model.js';
import { extractInterceptors } from '../../src/indexer/extractors/interceptors.js';

function extract(source: string, filePath = 'src/app/thing.ts') {
  const sourceFile = typescript.createSourceFile(filePath, source, typescript.ScriptTarget.ES2022, true);
  return extractInterceptors(typescript, sourceFile, filePath);
}

describe('extractInterceptors — declarations', () => {
  it('finds a functional interceptor by its HttpInterceptorFn annotation', () => {
    const { nodes } = extract(
      `import { HttpInterceptorFn } from '@angular/common/http';
       export const authInterceptor: HttpInterceptorFn = (req, next) => next(req);`,
      'src/app/core/interceptors/auth.interceptor.ts',
    );

    expect(nodes).toHaveLength(1);
    const node = nodes[0] as InterceptorNode;
    expect(node.kind).toBe('Interceptor');
    expect(node.name).toBe('authInterceptor');
    expect(node.id).toBe('src/app/core/interceptors/auth.interceptor.ts#authInterceptor');
    expect(node.interceptorKind).toBe('functional');
  });

  it('finds a class interceptor by the interface it implements', () => {
    const { nodes } = extract(
      `import { HttpInterceptor } from '@angular/common/http';
       export class LoggingInterceptor implements HttpInterceptor {
         intercept(req: any, next: any) { return next.handle(req); }
       }`,
      'src/app/core/interceptors/logging.interceptor.ts',
    );

    expect(nodes).toHaveLength(1);
    const node = nodes[0] as InterceptorNode;
    expect(node.name).toBe('LoggingInterceptor');
    expect(node.interceptorKind).toBe('class');
  });

  it('does not invent an interceptor from a similarly shaped declaration', () => {
    const { nodes } = extract(
      `export const notAnInterceptor = (req: unknown, next: unknown) => next;
       export class AlsoNot implements OnInit { ngOnInit() {} }
       export const typedButWrong: HttpHandlerFn = (req) => req;`,
    );

    expect(nodes).toEqual([]);
  });
});

describe('extractInterceptors — registrations', () => {
  it('records a functional registration through withInterceptors()', () => {
    const { registrations } = extract(
      `import { provideHttpClient, withInterceptors } from '@angular/common/http';
       import { authInterceptor } from './core/interceptors/auth.interceptor';
       export const appConfig = {
         providers: [provideHttpClient(withInterceptors([authInterceptor]))],
       };`,
      'src/app/app.config.ts',
    );

    expect(registrations).toHaveLength(1);
    expect(registrations[0]?.interceptorId).toBe('src/app/core/interceptors/auth.interceptor.ts#authInterceptor');
    // Resolved by joining the import specifier, never checked against disk.
    expect(registrations[0]?.confidence).toBe('inferred');
  });

  it('records a class registration through the HTTP_INTERCEPTORS multi-provider', () => {
    const { registrations } = extract(
      `import { HTTP_INTERCEPTORS } from '@angular/common/http';
       import { LoggingInterceptor } from './core/interceptors/logging.interceptor';
       export class AppModule {}
       const providers = [
         { provide: HTTP_INTERCEPTORS, useClass: LoggingInterceptor, multi: true },
       ];`,
      'src/app/app.module.ts',
    );

    expect(registrations).toHaveLength(1);
    expect(registrations[0]?.interceptorId).toBe('src/app/core/interceptors/logging.interceptor.ts#LoggingInterceptor');
    expect(registrations[0]?.confidence).toBe('inferred');
  });

  it('is certain when the interceptor is declared in the same file that registers it', () => {
    const { nodes, registrations } = extract(
      `import { HttpInterceptorFn, provideHttpClient, withInterceptors } from '@angular/common/http';
       export const localInterceptor: HttpInterceptorFn = (req, next) => next(req);
       export const appConfig = {
         providers: [provideHttpClient(withInterceptors([localInterceptor]))],
       };`,
      'src/app/app.config.ts',
    );

    expect(nodes).toHaveLength(1);
    expect(registrations[0]?.interceptorId).toBe('src/app/app.config.ts#localInterceptor');
    expect(registrations[0]?.confidence).toBe('certain');
  });

  it('reports a registration it cannot resolve as unknown instead of dropping it (R16)', () => {
    const { registrations } = extract(
      // A barrel re-export through a path alias: the specifier is not
      // relative, so no file path can be derived from it here.
      `import { withInterceptors } from '@angular/common/http';
       import { authInterceptor } from '@app/core';
       const providers = [withInterceptors([authInterceptor])];`,
      'src/app/app.config.ts',
    );

    expect(registrations).toHaveLength(1);
    expect(registrations[0]?.confidence).toBe('unknown');
  });

  it('ignores a provider for a different token, and an unnamed inline interceptor', () => {
    const { registrations } = extract(
      `import { HTTP_INTERCEPTORS } from '@angular/common/http';
       const providers = [
         { provide: SOME_OTHER_TOKEN, useClass: NotAnInterceptor, multi: true },
       ];
       const more = [withInterceptors([(req, next) => next(req)])];`,
      'src/app/app.config.ts',
    );

    expect(registrations).toEqual([]);
  });
});
