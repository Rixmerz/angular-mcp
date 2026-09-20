import { Routes } from '@angular/router';

import { authGuard } from '../../core/guards/auth.guard';
import { orderResolver } from '../../core/resolvers/order.resolver';

export const ORDERS_ROUTES: Routes = [
  {
    path: '',
    canActivate: [authGuard],
    children: [
      {
        path: '',
        loadComponent: () =>
          import('./order-list/order-list.component').then((m) => m.OrderListComponent),
        data: { pageSize: 10 },
      },
      {
        path: ':id',
        loadComponent: () =>
          import('./order-detail/order-detail.component').then((m) => m.OrderDetailComponent),
        resolve: { order: orderResolver },
      },
    ],
  },
];
