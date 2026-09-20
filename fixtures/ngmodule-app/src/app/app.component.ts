import { Component, Inject, Optional } from '@angular/core';

import { APP_CONFIG, AppConfig } from './core';

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrl: './app.component.css'
})
export class AppComponent {
  title = 'ngmodule-app';

  constructor(@Optional() @Inject(APP_CONFIG) config: AppConfig | null) {
    if (config) {
      this.title = config.appName;
    }
  }
}
