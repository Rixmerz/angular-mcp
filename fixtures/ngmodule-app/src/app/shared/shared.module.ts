import { CommonModule } from '@angular/common';
import { NgModule } from '@angular/core';

import { ShoutPipe } from './pipes';

@NgModule({
  declarations: [ShoutPipe],
  imports: [CommonModule],
  exports: [CommonModule, ShoutPipe],
})
export class SharedModule {}
