import { Inject, Injectable, Optional } from '@angular/core';
import { AppConfig, APP_CONFIG } from './tokens/app-config.token';

@Injectable({ providedIn: 'root' })
export class GreetingService {
  constructor(
    @Optional() @Inject(APP_CONFIG) private readonly config: AppConfig | null
  ) {}

  greet(name: string): string {
    const appName = this.config?.appName ?? 'ngmodule-app';
    return `Hola ${name}, bienvenido a ${appName}`;
  }
}
