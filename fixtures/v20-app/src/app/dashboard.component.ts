import { Component, computed, input, linkedSignal, signal } from '@angular/core';

import { MetricService } from './metric.service';

/**
 * No `standalone:` here on purpose. In Angular 19 and later that means
 * standalone; in 18 and earlier it meant the opposite. The indexer has to read
 * the version from this project rather than assume one.
 */
@Component({
  selector: 'app-dashboard',
  template: `
    @if (loading()) {
      <p>Loading…</p>
    } @else {
      @for (metric of metrics(); track metric.id) {
        <span class="metric">{{ metric.label }}: {{ metric.value }}</span>
      } @empty {
        <p>No metrics</p>
      }
    }
  `,
})
export class DashboardComponent {
  readonly title = input('Dashboard');

  readonly loading = signal(false);
  readonly metrics = signal<{ id: number; label: string; value: number }[]>([]);

  /** `linkedSignal` does not exist before Angular 19. */
  readonly selected = linkedSignal(() => this.metrics()[0] ?? null);

  readonly total = computed(() => this.metrics().reduce((sum, metric) => sum + metric.value, 0));

  constructor(private readonly metricService: MetricService) {}
}
