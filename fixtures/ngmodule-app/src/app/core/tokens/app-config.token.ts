import { InjectionToken } from '@angular/core';

export interface AppConfig {
  appName: string;
  apiBaseUrl: string;
}

export const APP_CONFIG = new InjectionToken<AppConfig>('APP_CONFIG');
