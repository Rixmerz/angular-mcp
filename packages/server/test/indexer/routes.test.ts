import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

import type { GraphEdge, GraphNode, GuardNode, ResolverNode, RouteNode } from '../../src/graph/model.js';
import { extractRoutes } from '../../src/indexer/extractors/routes.js';

function parse(fileName: string, source: string): ts.SourceFile {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function extract(fileName: string, source: string) {
  return extractRoutes(ts, parse(fileName, source));
}

function routeNodes(nodes: readonly GraphNode[]): RouteNode[] {
  return nodes.filter((n): n is RouteNode => n.kind === 'Route');
}

function guardNodes(nodes: readonly GraphNode[]): GuardNode[] {
  return nodes.filter((n): n is GuardNode => n.kind === 'Guard');
}

function resolverNodes(nodes: readonly GraphNode[]): ResolverNode[] {
  return nodes.filter((n): n is ResolverNode => n.kind === 'Resolver');
}

function edgesOfKind(edges: readonly GraphEdge[], kind: GraphEdge['kind']): GraphEdge[] {
  return edges.filter((e) => e.kind === kind);
}

describe('extractRoutes: declaracion de arrays de rutas', () => {
  it('extrae un array de rutas declarado como literal (const routes: Routes = [...])', () => {
    const { nodes } = extract(
      'src/app/app.routes.ts',
      `
        import { Routes } from '@angular/router';
        export const routes: Routes = [
          { path: '', redirectTo: 'home' },
        ];
      `,
    );

    const routes = routeNodes(nodes);
    expect(routes).toHaveLength(1);
    expect(routes[0]?.routePath).toBe('');
  });

  it('extrae las rutas pasadas a provideRouter(...) sin duplicar el array declarado por separado', () => {
    const { nodes } = extract(
      'src/app/app.config.ts',
      `
        import { provideRouter } from '@angular/router';
        import { HomeComponent } from './home/home.component';

        const routes = [
          { path: '', component: HomeComponent },
        ];

        export const appConfig = {
          providers: [provideRouter(routes)],
        };
      `,
    );

    const routes = routeNodes(nodes);
    expect(routes).toHaveLength(1);
    expect(routes[0]?.componentRef).toBe('src/app/home/home.component.ts#HomeComponent');
  });

  it('extrae las rutas pasadas a RouterModule.forRoot(...)', () => {
    const { nodes } = extract(
      'src/app/app-routing.module.ts',
      `
        import { NgModule } from '@angular/core';
        import { RouterModule, Routes } from '@angular/router';

        const routes: Routes = [
          { path: 'home', redirectTo: '' },
        ];

        @NgModule({
          imports: [RouterModule.forRoot(routes)],
          exports: [RouterModule],
        })
        export class AppRoutingModule {}
      `,
    );

    const routes = routeNodes(nodes);
    expect(routes).toHaveLength(1);
    expect(routes[0]?.routePath).toBe('home');
  });

  it('extrae las rutas pasadas a RouterModule.forChild(...)', () => {
    const { nodes } = extract(
      'src/app/admin/admin-routing.module.ts',
      `
        import { NgModule } from '@angular/core';
        import { RouterModule, Routes } from '@angular/router';

        const childRoutes: Routes = [
          { path: 'users', redirectTo: '' },
        ];

        @NgModule({
          imports: [RouterModule.forChild(childRoutes)],
        })
        export class AdminRoutingModule {}
      `,
    );

    const routes = routeNodes(nodes);
    expect(routes).toHaveLength(1);
    expect(routes[0]?.routePath).toBe('users');
  });

  it('resuelve component: hacia una clase declarada localmente en el mismo archivo, con confidence certain', () => {
    const { nodes, edges } = extract(
      'src/app/app.routes.ts',
      `
        import { Routes } from '@angular/router';
        class HomeComponent {}

        export const routes: Routes = [
          { path: '', component: HomeComponent },
        ];
      `,
    );

    const route = routeNodes(nodes)[0];
    expect(route?.componentRef).toBe('src/app/app.routes.ts#HomeComponent');

    const routesTo = edgesOfKind(edges, 'routes_to');
    expect(routesTo).toHaveLength(1);
    expect(routesTo[0]?.confidence).toBe('certain');
  });
});

describe('extractRoutes: loadComponent y loadChildren con import() dinamico', () => {
  it('resuelve loadComponent con () => import(...).then(m => m.X) hasta el simbolo destino', () => {
    const { nodes, edges } = extract(
      'src/app/app.routes.ts',
      `
        import { Routes } from '@angular/router';
        export const routes: Routes = [
          {
            path: 'admin',
            loadComponent: () => import('./admin/admin.component').then((m) => m.AdminComponent),
          },
        ];
      `,
    );

    const route = routeNodes(nodes)[0];
    expect(route?.lazy).toEqual({
      kind: 'loadComponent',
      specifier: './admin/admin.component',
      confidence: 'inferred',
    });
    expect(route?.componentRef).toBe('src/app/admin/admin.component.ts#AdminComponent');

    const routesTo = edgesOfKind(edges, 'routes_to');
    expect(routesTo).toHaveLength(1);
    expect(routesTo[0]?.to).toBe('src/app/admin/admin.component.ts#AdminComponent');
    expect(routesTo[0]?.confidence).toBe('inferred');
  });

  it('resuelve loadComponent con destructuring en el callback: .then(({ X }) => X)', () => {
    const { nodes } = extract(
      'src/app/app.routes.ts',
      `
        import { Routes } from '@angular/router';
        export const routes: Routes = [
          {
            path: 'admin',
            loadComponent: () => import('./admin/admin.component').then(({ AdminComponent }) => AdminComponent),
          },
        ];
      `,
    );

    const route = routeNodes(nodes)[0];
    expect(route?.componentRef).toBe('src/app/admin/admin.component.ts#AdminComponent');
  });

  it('resuelve loadComponent con async/await: async () => (await import(...)).X', () => {
    const { nodes } = extract(
      'src/app/app.routes.ts',
      `
        import { Routes } from '@angular/router';
        export const routes: Routes = [
          {
            path: 'admin',
            loadComponent: async () => (await import('./admin/admin.component')).AdminComponent,
          },
        ];
      `,
    );

    const route = routeNodes(nodes)[0];
    expect(route?.componentRef).toBe('src/app/admin/admin.component.ts#AdminComponent');
  });

  it('resuelve loadComponent sin .then() como la exportacion default del modulo', () => {
    const { nodes } = extract(
      'src/app/app.routes.ts',
      `
        import { Routes } from '@angular/router';
        export const routes: Routes = [
          { path: 'admin', loadComponent: () => import('./admin/admin.component') },
        ];
      `,
    );

    const route = routeNodes(nodes)[0];
    expect(route?.componentRef).toBe('src/app/admin/admin.component.ts#default');
  });

  it('resuelve loadChildren con import() sin crear una arista routes_to (el destino no es un Component)', () => {
    const { nodes, edges } = extract(
      'src/app/app.routes.ts',
      `
        import { Routes } from '@angular/router';
        export const routes: Routes = [
          {
            path: 'admin',
            loadChildren: () => import('./admin/admin.routes').then((m) => m.ADMIN_ROUTES),
          },
        ];
      `,
    );

    const route = routeNodes(nodes)[0];
    expect(route?.lazy).toEqual({
      kind: 'loadChildren',
      specifier: './admin/admin.routes',
      confidence: 'inferred',
    });
    expect(route?.componentRef).toBeUndefined();
    expect(edgesOfKind(edges, 'routes_to')).toHaveLength(0);
  });

  it('marca confidence unknown y guarda el texto del especificador cuando no es estatico', () => {
    const { nodes } = extract(
      'src/app/app.routes.ts',
      `
        import { Routes } from '@angular/router';
        declare const pageName: string;
        export const routes: Routes = [
          {
            path: 'dynamic',
            loadComponent: () => import(\`./pages/\${pageName}.component\`).then((m) => m.default),
          },
        ];
      `,
    );

    const route = routeNodes(nodes)[0];
    expect(route?.lazy).toMatchObject({ kind: 'loadComponent', confidence: 'unknown' });
    expect((route?.lazy as { specifier: string }).specifier).toContain('pageName');
    expect(route?.componentRef).toBeUndefined();
  });

  it('marca confidence unknown cuando el callback de .then() no se puede interpretar', () => {
    const { nodes } = extract(
      'src/app/app.routes.ts',
      `
        import { Routes } from '@angular/router';
        export const routes: Routes = [
          {
            path: 'admin',
            loadComponent: () => import('./admin/admin.component').then((m) => pickComponent(m)),
          },
        ];
      `,
    );

    const route = routeNodes(nodes)[0];
    expect(route?.lazy).toEqual({
      kind: 'loadComponent',
      specifier: './admin/admin.component',
      confidence: 'unknown',
    });
    expect(route?.componentRef).toBeUndefined();
  });
});

describe('extractRoutes: children anidados', () => {
  it('produce nodos Route y aristas child_of para rutas hijas anidadas', () => {
    const { nodes, edges } = extract(
      'src/app/app.routes.ts',
      `
        import { Routes } from '@angular/router';
        export const routes: Routes = [
          {
            path: 'admin',
            children: [
              { path: 'users', redirectTo: '' },
              { path: 'settings', redirectTo: '' },
            ],
          },
        ];
      `,
    );

    const routes = routeNodes(nodes);
    expect(routes).toHaveLength(3);

    const parent = routes.find((r) => r.routePath === 'admin');
    const users = routes.find((r) => r.routePath === 'users');
    const settings = routes.find((r) => r.routePath === 'settings');
    expect(parent).toBeDefined();
    expect(users).toBeDefined();
    expect(settings).toBeDefined();
    expect(parent?.children).toEqual([users?.id, settings?.id]);

    const childOf = edgesOfKind(edges, 'child_of');
    expect(childOf).toHaveLength(2);
    expect(childOf.map((e) => e.from).sort()).toEqual([users?.id, settings?.id].sort());
    expect(childOf.every((e) => e.to === parent?.id)).toBe(true);
    expect(childOf.every((e) => e.confidence === 'certain')).toBe(true);
  });
});

describe('extractRoutes: guards y resolvers, funcionales y de clase', () => {
  const source = `
    import { Routes } from '@angular/router';
    import { AdminGuard } from './guards/admin.guard';
    import { authGuard } from './guards/auth.guard';
    import { userResolver } from './resolvers/user.resolver';
    import { ConfigResolver } from './resolvers/config.resolver';

    function localFunctionalGuard() { return true; }
    class LocalClassGuard {}

    export const routes: Routes = [
      {
        path: 'admin',
        canActivate: [
          authGuard,
          AdminGuard,
          localFunctionalGuard,
          LocalClassGuard,
          () => true,
          someUndeclaredGuard,
        ],
        resolve: {
          user: userResolver,
          config: ConfigResolver,
        },
      },
    ];
  `;

  it('detecta guards funcionales y de clase, locales e importados, con la confidence correcta', () => {
    const { nodes, edges } = extract('src/app/app.routes.ts', source);
    const guards = guardNodes(nodes);
    const route = routeNodes(nodes)[0];

    expect(guards).toHaveLength(6);
    expect(route?.guards).toHaveLength(6);
    expect(edgesOfKind(edges, 'guarded_by')).toHaveLength(6);

    const byName = new Map(guards.map((g) => [g.name, g]));

    expect(byName.get('authGuard')).toMatchObject({
      id: 'src/app/guards/auth.guard.ts#authGuard',
      guardKind: 'functional',
    });
    expect(edges.find((e) => e.kind === 'guarded_by' && e.to === 'src/app/guards/auth.guard.ts#authGuard')?.confidence).toBe(
      'inferred',
    );

    expect(byName.get('AdminGuard')).toMatchObject({
      id: 'src/app/guards/admin.guard.ts#AdminGuard',
      guardKind: 'class',
    });
    expect(
      edges.find((e) => e.kind === 'guarded_by' && e.to === 'src/app/guards/admin.guard.ts#AdminGuard')?.confidence,
    ).toBe('inferred');

    expect(byName.get('localFunctionalGuard')).toMatchObject({
      id: 'src/app/app.routes.ts#localFunctionalGuard',
      guardKind: 'functional',
    });
    expect(
      edges.find((e) => e.kind === 'guarded_by' && e.to === 'src/app/app.routes.ts#localFunctionalGuard')?.confidence,
    ).toBe('certain');

    expect(byName.get('LocalClassGuard')).toMatchObject({
      id: 'src/app/app.routes.ts#LocalClassGuard',
      guardKind: 'class',
    });
    expect(
      edges.find((e) => e.kind === 'guarded_by' && e.to === 'src/app/app.routes.ts#LocalClassGuard')?.confidence,
    ).toBe('certain');

    const anonymous = guards.find((g) => g.name.startsWith('Guard@'));
    expect(anonymous).toMatchObject({ guardKind: 'functional' });
    expect(edges.find((e) => e.kind === 'guarded_by' && e.to === anonymous?.id)?.confidence).toBe('certain');

    expect(byName.get('someUndeclaredGuard')).toMatchObject({
      id: 'src/app/app.routes.ts#someUndeclaredGuard',
      guardKind: 'functional',
    });
    expect(
      edges.find((e) => e.kind === 'guarded_by' && e.to === 'src/app/app.routes.ts#someUndeclaredGuard')?.confidence,
    ).toBe('unknown');
  });

  it('detecta resolvers funcionales y de clase a partir del objeto resolve: {...}', () => {
    const { nodes, edges } = extract('src/app/app.routes.ts', source);
    const resolvers = resolverNodes(nodes);
    const route = routeNodes(nodes)[0];

    expect(resolvers).toHaveLength(2);
    expect(route?.resolvers).toHaveLength(2);
    expect(edgesOfKind(edges, 'resolves_with')).toHaveLength(2);

    const byName = new Map(resolvers.map((r) => [r.name, r]));
    expect(byName.get('userResolver')).toMatchObject({
      id: 'src/app/resolvers/user.resolver.ts#userResolver',
      resolverKind: 'functional',
    });
    expect(byName.get('ConfigResolver')).toMatchObject({
      id: 'src/app/resolvers/config.resolver.ts#ConfigResolver',
      resolverKind: 'class',
    });
  });
});

describe('extractRoutes: data de la ruta', () => {
  it('evalua propiedades literales de data', () => {
    const { nodes } = extract(
      'src/app/app.routes.ts',
      `
        import { Routes } from '@angular/router';
        export const routes: Routes = [
          { path: 'admin', data: { title: 'Admin', roles: ['admin', 'owner'], strict: true } },
        ];
      `,
    );

    const route = routeNodes(nodes)[0];
    expect(route?.data).toEqual({ title: 'Admin', roles: ['admin', 'owner'], strict: true });
  });
});
