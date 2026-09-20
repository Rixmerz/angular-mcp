import * as typescript from 'typescript';
import { describe, expect, it } from 'vitest';

import { extractHttpCalls } from '../../src/indexer/extractors/http.js';
import type { HttpCallNode } from '../../src/graph/model.js';

function parse(source: string, fileName = 'src/app/example.service.ts'): typescript.SourceFile {
  return typescript.createSourceFile(fileName, source, typescript.ScriptTarget.Latest, true, typescript.ScriptKind.TS);
}

describe('extractHttpCalls', () => {
  it('detects get, post, put, patch and delete on a field injected with inject(HttpClient)', () => {
    const sourceFile = parse(`
      import { HttpClient } from '@angular/common/http';
      import { Injectable, inject } from '@angular/core';

      @Injectable({ providedIn: 'root' })
      export class WidgetService {
        private readonly http = inject(HttpClient);

        list() { return this.http.get('/widgets'); }
        create() { return this.http.post('/widgets', {}); }
        replace() { return this.http.put('/widgets/1', {}); }
        patch() { return this.http.patch('/widgets/1', {}); }
        remove() { return this.http.delete('/widgets/1'); }
      }
    `);

    const { nodes, edges } = extractHttpCalls(typescript, sourceFile, 'src/app/example.service.ts');
    const byMethod = new Map(nodes.map((node) => [node.method, node]));

    expect(nodes).toHaveLength(5);
    expect([...byMethod.keys()].sort()).toEqual(['delete', 'get', 'patch', 'post', 'put']);
    expect(edges).toHaveLength(5);
    for (const edge of edges) {
      expect(edge.kind).toBe('calls_http');
      expect(edge.from).toBe('src/app/example.service.ts#WidgetService');
      expect(edge.confidence).toBe('certain');
    }
    expect(edges.map((edge) => edge.to)).toEqual(nodes.map((node) => node.id));
  });

  it('detects a field typed as HttpClient via a constructor parameter property', () => {
    const sourceFile = parse(`
      import { HttpClient } from '@angular/common/http';
      import { Injectable } from '@angular/core';

      @Injectable({ providedIn: 'root' })
      export class WidgetService {
        constructor(private readonly http: HttpClient) {}

        list() { return this.http.get('/widgets'); }
      }
    `);

    const { nodes } = extractHttpCalls(typescript, sourceFile, 'src/app/example.service.ts');
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.method).toBe('get');
  });

  it('resolves a plain string literal URL as literal', () => {
    const sourceFile = parse(`
      import { HttpClient } from '@angular/common/http';
      import { Injectable, inject } from '@angular/core';

      @Injectable({ providedIn: 'root' })
      export class UserService {
        private readonly http = inject(HttpClient);

        getUsers() {
          return this.http.get<User[]>('https://api.example.com/users');
        }
      }
    `);

    const { nodes } = extractHttpCalls(typescript, sourceFile, 'src/app/core/services/user.service.ts');
    const call = nodes[0] as HttpCallNode;

    expect(call.urlConfidence).toBe('literal');
    expect(call.urlPattern).toBe('https://api.example.com/users');
    expect(call.responseTypeText).toBe('User[]');
    expect(call.requestTypeText).toBeUndefined();
    expect(call.callerRef).toBe('src/app/core/services/user.service.ts#UserService');
    expect(call.id).toBe('src/app/core/services/user.service.ts#UserService.getUsers.get');
  });

  it('resolves environment.apiUrl in a template literal with no other substitutions as template', () => {
    const sourceFile = parse(`
      import { HttpClient } from '@angular/common/http';
      import { Injectable, inject } from '@angular/core';
      import { environment } from '../../../environments/environment';
      import { Order } from '../models/order.model';

      @Injectable({ providedIn: 'root' })
      export class OrderService {
        private readonly http = inject(HttpClient);

        createOrder(order: Partial<Order>) {
          return this.http.post<Order>(\`\${environment.apiUrl}/orders\`, order);
        }
      }
    `);

    const { nodes } = extractHttpCalls(typescript, sourceFile, 'src/app/core/services/order.service.ts');
    const call = nodes[0] as HttpCallNode;

    expect(call.urlConfidence).toBe('template');
    expect(call.urlPattern).toBe('${environment.apiUrl}/orders');
    expect(call.method).toBe('post');
    expect(call.responseTypeText).toBe('Order');
    expect(call.requestTypeText).toBe('Partial<Order>');
  });

  it('resolves a template literal mixing environment.apiUrl with a dynamic id as unknown, never guessing the id', () => {
    const sourceFile = parse(`
      import { HttpClient } from '@angular/common/http';
      import { Injectable, inject } from '@angular/core';
      import { environment } from '../../../environments/environment';

      @Injectable({ providedIn: 'root' })
      export class UserService {
        private readonly http = inject(HttpClient);

        getUser(id: number) {
          return this.http.get<User>(\`\${environment.apiUrl}/users/\${id}\`);
        }
      }
    `);

    const { nodes } = extractHttpCalls(typescript, sourceFile, 'src/app/core/services/user.service.ts');
    const call = nodes[0] as HttpCallNode;

    expect(call.urlConfidence).toBe('unknown');
    expect(call.urlPattern).toBe('`${environment.apiUrl}/users/${id}`');
  });

  it('resolves simple string concatenation of static parts as template', () => {
    const sourceFile = parse(`
      import { HttpClient } from '@angular/common/http';
      import { Injectable, inject } from '@angular/core';

      export const API_BASE = '/api';

      @Injectable({ providedIn: 'root' })
      export class WidgetService {
        private readonly http = inject(HttpClient);

        list() {
          return this.http.get(API_BASE + '/widgets');
        }
      }
    `);

    const { nodes } = extractHttpCalls(typescript, sourceFile, 'src/app/example.service.ts');
    const call = nodes[0] as HttpCallNode;

    expect(call.urlConfidence).toBe('template');
    expect(call.urlPattern).toBe('/api/widgets');
  });

  it('resolves a direct reference to an exported constant as template', () => {
    const sourceFile = parse(`
      import { HttpClient } from '@angular/common/http';
      import { Injectable, inject } from '@angular/core';

      export const WIDGETS_URL = '/api/widgets';

      @Injectable({ providedIn: 'root' })
      export class WidgetService {
        private readonly http = inject(HttpClient);

        list() {
          return this.http.get(WIDGETS_URL);
        }
      }
    `);

    const { nodes } = extractHttpCalls(typescript, sourceFile, 'src/app/example.service.ts');
    const call = nodes[0] as HttpCallNode;

    expect(call.urlConfidence).toBe('template');
    expect(call.urlPattern).toBe('/api/widgets');
  });

  it('reports unknown with the original text for a local (non-exported) const, never inventing the URL', () => {
    const sourceFile = parse(`
      import { HttpClient } from '@angular/common/http';
      import { Injectable, inject } from '@angular/core';
      import { environment } from '../../../environments/environment';

      @Injectable({ providedIn: 'root' })
      export class OrderService {
        private readonly http = inject(HttpClient);

        getOrders() {
          const url = \`\${environment.apiUrl}/orders\`;
          return this.http.get(url);
        }
      }
    `);

    const { nodes } = extractHttpCalls(typescript, sourceFile, 'src/app/core/services/order.service.ts');
    const call = nodes[0] as HttpCallNode;

    expect(call.urlConfidence).toBe('unknown');
    expect(call.urlPattern).toBe('url');
  });

  it('reports unknown with the original text for a URL built from a method call', () => {
    const sourceFile = parse(`
      import { HttpClient } from '@angular/common/http';
      import { Injectable, inject } from '@angular/core';

      @Injectable({ providedIn: 'root' })
      export class WidgetService {
        private readonly http = inject(HttpClient);

        list() {
          return this.http.get(this.buildUrl());
        }

        private buildUrl(): string { return '/widgets'; }
      }
    `);

    const { nodes } = extractHttpCalls(typescript, sourceFile, 'src/app/example.service.ts');
    const call = nodes[0] as HttpCallNode;

    expect(call.urlConfidence).toBe('unknown');
    expect(call.urlPattern).toBe('this.buildUrl()');
  });

  it('detects a call nested inside an effect() callback inside the constructor, matching the enclosing member to the constructor', () => {
    const sourceFile = parse(`
      import { HttpClient } from '@angular/common/http';
      import { Component, computed, effect, inject, input, signal } from '@angular/core';
      import { environment } from '../../../../environments/environment';
      import { Order } from '../../../core/models/order.model';

      @Component({ selector: 'app-order-detail' })
      export class OrderDetailComponent {
        private readonly http = inject(HttpClient);
        readonly orderId = input.required<number>();
        readonly order = signal<Order | null>(null);

        constructor() {
          effect(() => {
            const id = this.orderId();
            this.http.get<Order>(\`\${environment.apiUrl}/orders/\${id}\`).subscribe((order) => {
              this.order.set(order);
            });
          });
        }
      }
    `, 'src/app/features/orders/order-detail/order-detail.component.ts');

    const { nodes, edges } = extractHttpCalls(
      typescript,
      sourceFile,
      'src/app/features/orders/order-detail/order-detail.component.ts',
    );

    expect(nodes).toHaveLength(1);
    const call = nodes[0] as HttpCallNode;
    expect(call.method).toBe('get');
    expect(call.urlConfidence).toBe('unknown');
    expect(call.name).toBe('constructor.get');
    expect(call.callerRef).toBe(
      'src/app/features/orders/order-detail/order-detail.component.ts#OrderDetailComponent',
    );
    expect(edges).toHaveLength(1);
    expect(edges[0]!.from).toBe(call.callerRef);
    expect(edges[0]!.to).toBe(call.id);
  });

  it('disambiguates two http calls in the same method with the same http verb', () => {
    const sourceFile = parse(`
      import { HttpClient } from '@angular/common/http';
      import { Injectable, inject } from '@angular/core';

      @Injectable({ providedIn: 'root' })
      export class WidgetService {
        private readonly http = inject(HttpClient);

        loadBoth() {
          this.http.get('/a').subscribe();
          this.http.get('/b').subscribe();
        }
      }
    `);

    const { nodes } = extractHttpCalls(typescript, sourceFile, 'src/app/example.service.ts');
    expect(nodes.map((node) => node.name)).toEqual(['loadBoth.get1', 'loadBoth.get2']);
    expect(nodes.map((node) => node.urlPattern)).toEqual(['/a', '/b']);
  });

  it('ignores HttpClient-shaped calls on a field that was never bound to HttpClient', () => {
    const sourceFile = parse(`
      import { Injectable } from '@angular/core';

      @Injectable({ providedIn: 'root' })
      export class NotAService {
        private readonly http = { get: (url: string) => url };

        list() { return this.http.get('/widgets'); }
      }
    `);

    const { nodes, edges } = extractHttpCalls(typescript, sourceFile, 'src/app/example.service.ts');
    expect(nodes).toEqual([]);
    expect(edges).toEqual([]);
  });

  it('returns nothing for a file that never imports HttpClient', () => {
    const sourceFile = parse(`
      export class PlainClass {
        list() { return []; }
      }
    `);

    const { nodes, edges } = extractHttpCalls(typescript, sourceFile, 'src/app/example.ts');
    expect(nodes).toEqual([]);
    expect(edges).toEqual([]);
  });
});
