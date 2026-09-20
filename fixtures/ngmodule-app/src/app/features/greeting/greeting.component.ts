import { Component } from '@angular/core';

import { GreetingService } from '../../core/greeting.service';

@Component({
  selector: 'app-greeting',
  templateUrl: './greeting.component.html',
})
export class GreetingComponent {
  names = ['Ada', 'Alan', 'Grace'];
  status: 'loading' | 'ready' | 'error' = 'ready';

  constructor(private readonly greetingService: GreetingService) {}

  greet(name: string): string {
    return this.greetingService.greet(name);
  }
}
