import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';

import { ShoutPipe } from './pipes/shout.pipe';

@NgModule({
  declarations: [ShoutPipe],
  imports: [CommonModule],
  exports: [ShoutPipe, CommonModule],
})
export class SharedModule {}
