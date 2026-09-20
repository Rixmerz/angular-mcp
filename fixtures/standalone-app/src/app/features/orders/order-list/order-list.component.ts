import { CommonModule } from '@angular/common';
import {
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  model,
  signal,
  viewChild,
} from '@angular/core';

import { Order } from '../../../core/models/order.model';
import { OrderService } from '../../../core/services/order.service';

type LoadStatus = 'loading' | 'error' | 'loaded';

@Component({
  selector: 'app-order-list',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './order-list.component.html',
})
export class OrderListComponent {
  private readonly orderService = inject(OrderService);

  readonly pageSize = input.required<number>();
  readonly currentPage = model(1);

  readonly paginatorEl = viewChild<ElementRef<HTMLDivElement>>('paginator');

  readonly status = signal<LoadStatus>('loading');
  readonly orders = signal<Order[]>([]);
  readonly totalItems = signal(0);

  readonly totalPages = computed(() => Math.ceil(this.totalItems() / this.pageSize()) || 1);

  constructor() {
    effect(
      () => {
        const page = this.currentPage();
        const size = this.pageSize();
        this.status.set('loading');
        this.orderService.getOrders(page, size).subscribe({
          next: (result) => {
            this.orders.set(result.items);
            this.totalItems.set(result.totalItems);
            this.status.set('loaded');
          },
          error: () => this.status.set('error'),
        });
      },
      { allowSignalWrites: true },
    );
  }

  goToPage(page: number): void {
    if (page >= 1 && page <= this.totalPages()) {
      this.currentPage.set(page);
    }
  }
}
