import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'users' },
  {
    path: 'users',
    loadComponent: () =>
      import('./features/users/user-list/user-list.component').then((m) => m.UserListComponent),
  },
  {
    path: 'orders',
    loadChildren: () => import('./features/orders/orders.routes').then((m) => m.ORDERS_ROUTES),
  },
];
