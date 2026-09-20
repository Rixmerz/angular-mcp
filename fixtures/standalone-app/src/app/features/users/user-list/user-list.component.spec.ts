import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideHttpClient } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';

import { UserListComponent } from './user-list.component';

describe('UserListComponent', () => {
  let httpMock: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [UserListComponent],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();

    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
  });

  it('should create', () => {
    const fixture = TestBed.createComponent(UserListComponent);
    fixture.detectChanges();
    httpMock.expectOne('https://api.example.com/users').flush([]);
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('should filter users by search term', () => {
    const fixture = TestBed.createComponent(UserListComponent);
    const component = fixture.componentInstance;
    fixture.detectChanges();

    httpMock
      .expectOne('https://api.example.com/users')
      .flush([
        { id: 1, name: 'Ada Lovelace', email: 'ada@example.com' },
        { id: 2, name: 'Grace Hopper', email: 'grace@example.com' },
      ]);
    fixture.detectChanges();

    component.searchTerm.set('grace');
    expect(component.filteredUsers().length).toBe(1);
    expect(component.filteredUsers()[0].name).toBe('Grace Hopper');
  });

  it('should emit the selected user id', () => {
    const fixture = TestBed.createComponent(UserListComponent);
    const component = fixture.componentInstance;
    fixture.detectChanges();
    httpMock.expectOne('https://api.example.com/users').flush([]);

    let emitted: number | undefined;
    component.userSelected.subscribe((id) => (emitted = id));
    component.selectUser(42);

    expect(emitted).toBe(42);
  });
});
