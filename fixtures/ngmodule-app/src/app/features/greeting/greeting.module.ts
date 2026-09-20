import { NgModule, Optional, SkipSelf } from '@angular/core';
import { CommonModule } from '@angular/common';

import { SharedModule } from '../../shared/shared.module';
import { GreetingService } from '../../core/greeting.service';
import { GreetingRoutingModule } from './greeting-routing.module';
import { GreetingComponent } from './greeting.component';
import { StandaloneBadgeComponent } from './standalone-badge.component';

@NgModule({
  declarations: [GreetingComponent],
  imports: [
    CommonModule,
    SharedModule,
    GreetingRoutingModule,
    StandaloneBadgeComponent,
  ],
  exports: [GreetingComponent],
  providers: [GreetingService],
})
export class GreetingModule {
  constructor(@Optional() @SkipSelf() parentModule: GreetingModule) {
    if (parentModule) {
      throw new Error('GreetingModule ya esta cargado. Importalo solo desde el router.');
    }
  }
}
