import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Component, computed, effect, inject, input, signal } from '@angular/core';

import { environment } from '../../../../environments/environment';
import { Order } from '../../../core/models/order.model';

// PLANTED VIOLATION: this component calls HttpClient directly instead of
// delegating to OrderService. It exists on purpose so that angular_check_rules
// detects the "no-http-in-components" rule violation (see docs/PLAN.md, 9.3).
@Component({
  selector: 'app-order-detail',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './order-detail.component.html',
})
export class OrderDetailComponent {
  private readonly http = inject(HttpClient);

  readonly orderId = input.required<number>();
  readonly order = signal<Order | null>(null);

  readonly hasOrder = computed(() => this.order() !== null);

  constructor() {
    effect(() => {
      const id = this.orderId();
      this.http.get<Order>(`${environment.apiUrl}/orders/${id}`).subscribe((order) => {
        this.order.set(order);
      });
    });
  }
}
