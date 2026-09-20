import { InjectionToken } from '@angular/core';

export interface AppConfig {
  appName: string;
}

export const APP_CONFIG = new InjectionToken<AppConfig>('APP_CONFIG');

export const LOGGER = new InjectionToken<{ log(msg: string): void }>('LOGGER');
