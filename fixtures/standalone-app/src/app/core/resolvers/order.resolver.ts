import { inject } from '@angular/core';
import { ResolveFn } from '@angular/router';

import { Order } from '../models/order.model';
import { OrderService } from '../services/order.service';

export const orderResolver: ResolveFn<Order> = (route) => {
  const orderService = inject(OrderService);
  const id = Number(route.paramMap.get('id'));
  return orderService.getOrder(id);
};
