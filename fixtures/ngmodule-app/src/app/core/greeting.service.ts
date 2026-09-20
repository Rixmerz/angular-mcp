import { HttpClient } from '@angular/common/http';
import { Inject, Injectable, Optional } from '@angular/core';
import { Observable } from 'rxjs';
import { AppConfig, APP_CONFIG } from './tokens/app-config.token';

@Injectable({ providedIn: 'root' })
export class GreetingService {
  constructor(
    private readonly http: HttpClient,
    @Optional() @Inject(APP_CONFIG) private readonly config: AppConfig | null
  ) {}

  // The request every registered interceptor sees. LoggingInterceptor is
  // registered in app.module.ts through the './core' barrel, so indexing this
  // fixture exercises resolving a registration that no direct relative
  // import path can name (R16).
  loadGreetings(): Observable<string[]> {
    return this.http.get<string[]>('/api/greetings');
  }

  greet(name: string): string {
    const appName = this.config?.appName ?? 'ngmodule-app';
    return `Hello ${name}, welcome to ${appName}`;
  }
}
