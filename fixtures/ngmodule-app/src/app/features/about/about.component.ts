import { Component } from '@angular/core';

import { AboutFact, AboutService } from './about.service';

@Component({
  selector: 'app-about',
  templateUrl: './about.component.html',
})
export class AboutComponent {
  status: 'loading' | 'ready' | 'empty' = 'ready';

  constructor(private readonly aboutService: AboutService) {}

  get facts(): AboutFact[] {
    return this.aboutService.getFacts();
  }
}
