import { TestBed } from '@angular/core/testing';

import { AboutService } from './about.service';

describe('AboutService', () => {
  let service: AboutService;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [AboutService] });
    service = TestBed.inject(AboutService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  it('should return the list of facts', () => {
    const facts = service.getFacts();
    expect(facts.length).toBeGreaterThan(0);
    expect(facts[0].label).toBeTruthy();
  });
});
