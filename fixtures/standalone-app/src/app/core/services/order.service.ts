import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { environment } from '../../../environments/environment';
import { Order, PagedResult } from '../models/order.model';

@Injectable({ providedIn: 'root' })
export class OrderService {
  private readonly http = inject(HttpClient);

  getOrders(page: number, pageSize: number): Observable<PagedResult<Order>> {
    const url = `${environment.apiUrl}/orders`;
    const params = new HttpParams().set('page', page).set('pageSize', pageSize);
    return this.http.get<PagedResult<Order>>(url, { params });
  }

  getOrder(id: number): Observable<Order> {
    return this.http.get<Order>('https://api.example.com/orders/single');
  }

  createOrder(order: Partial<Order>): Observable<Order> {
    return this.http.post<Order>(`${environment.apiUrl}/orders`, order);
  }
}
