import { CommonModule } from '@angular/common';
import { Component, computed, inject, input, output, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';

import { UserService } from '../../../core/services/user.service';

@Component({
  selector: 'app-user-list',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './user-list.component.html',
})
export class UserListComponent {
  private readonly userService = inject(UserService);

  readonly pageTitle = input('Users');
  readonly userSelected = output<number>();

  readonly searchTerm = signal('');
  readonly users = toSignal(this.userService.getUsers(), { initialValue: [] });

  readonly filteredUsers = computed(() => {
    const term = this.searchTerm().toLowerCase();
    return this.users().filter((user) => user.name.toLowerCase().includes(term));
  });

  selectUser(id: number): void {
    this.userSelected.emit(id);
  }
}
