import { Inject, Injectable, Optional } from '@angular/core';
import { APP_CONFIG, AppConfig, LOGGER } from './tokens';

@Injectable({ providedIn: 'root' })
export class GreetingService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Optional() @Inject(LOGGER) private readonly logger: { log(msg: string): void } | null,
  ) {}

  greet(): string {
    const message = `Hola desde ${this.config.appName}`;
    this.logger?.log(message);
    return message;
  }
}
