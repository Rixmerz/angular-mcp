import { Pipe, PipeTransform } from '@angular/core';

@Pipe({
  name: 'shout',
  standalone: false,
})
export class ShoutPipe implements PipeTransform {
  transform(value: string): string {
    return value ? `${value.toUpperCase()}!` : '';
  }
}
