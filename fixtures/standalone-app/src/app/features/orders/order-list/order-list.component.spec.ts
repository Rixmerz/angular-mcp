import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideHttpClient } from '@angular/common/http';
import { TestBed, fakeAsync, tick } from '@angular/core/testing';

import { OrderListComponent } from './order-list.component';

describe('OrderListComponent', () => {
  let httpMock: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [OrderListComponent],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();

    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
  });

  it('should create and request the first page with server-side pagination', fakeAsync(() => {
    const fixture = TestBed.createComponent(OrderListComponent);
    fixture.componentRef.setInput('pageSize', 10);
    fixture.detectChanges();
    tick();

    const req = httpMock.expectOne('https://api.dev.example.com/orders?page=1&pageSize=10');
    expect(req.request.method).toBe('GET');
    req.flush({ items: [], page: 1, pageSize: 10, totalItems: 0 });

    expect(fixture.componentInstance.status()).toBe('loaded');
  }));

  it('should request the next page when currentPage model changes', fakeAsync(() => {
    const fixture = TestBed.createComponent(OrderListComponent);
    fixture.componentRef.setInput('pageSize', 5);
    fixture.detectChanges();
    tick();
    httpMock
      .expectOne('https://api.dev.example.com/orders?page=1&pageSize=5')
      .flush({ items: [], page: 1, pageSize: 5, totalItems: 12 });

    fixture.componentInstance.goToPage(2);
    tick();

    const req = httpMock.expectOne('https://api.dev.example.com/orders?page=2&pageSize=5');
    req.flush({ items: [], page: 2, pageSize: 5, totalItems: 12 });

    expect(fixture.componentInstance.currentPage()).toBe(2);
  }));
});
