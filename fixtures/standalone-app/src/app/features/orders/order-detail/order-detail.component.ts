import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Component, computed, effect, inject, input, signal } from '@angular/core';

import { environment } from '../../../../environments/environment';
import { Order } from '../../../core/models/order.model';

// VIOLACION PLANTADA: este componente llama a HttpClient directamente en vez
// de delegar en OrderService. Existe a proposito para que angular_check_rules
// detecte la infraccion de la regla "no-http-in-components" (ver docs/PLAN.md, 9.3).
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
