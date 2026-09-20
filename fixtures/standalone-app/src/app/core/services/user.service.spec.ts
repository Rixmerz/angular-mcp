import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideHttpClient } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';

import { UserService } from './user.service';

describe('UserService', () => {
  let service: UserService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(UserService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  it('should fetch the user list from a literal URL', () => {
    service.getUsers().subscribe((users) => {
      expect(users).toEqual([]);
    });

    const req = httpMock.expectOne('https://api.example.com/users');
    expect(req.request.method).toBe('GET');
    req.flush([]);
  });

  it('should fetch a single user from environment.apiUrl', () => {
    service.getUser(1).subscribe((user) => {
      expect(user.id).toBe(1);
    });

    const req = httpMock.expectOne('https://api.dev.example.com/users/1');
    expect(req.request.method).toBe('GET');
    req.flush({ id: 1, name: 'Ada', email: 'ada@example.com' });
  });
});
