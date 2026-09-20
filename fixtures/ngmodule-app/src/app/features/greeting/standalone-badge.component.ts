import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-standalone-badge',
  standalone: true,
  imports: [CommonModule],
  template: `<span class="badge" *ngIf="label">{{ label }}</span>`,
})
export class StandaloneBadgeComponent {
  @Input() label = '';
}
