import { CommonModule } from '@angular/common';
import { TestBed } from '@angular/core/testing';

import { AboutComponent } from './about.component';
import { AboutService } from './about.service';

describe('AboutComponent', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [CommonModule],
      declarations: [AboutComponent],
      providers: [AboutService],
    }).compileComponents();
  });

  it('should create', () => {
    const fixture = TestBed.createComponent(AboutComponent);
    const component = fixture.componentInstance;
    expect(component).toBeTruthy();
  });

  it('should list facts from the service', () => {
    const fixture = TestBed.createComponent(AboutComponent);
    fixture.detectChanges();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelectorAll('li').length).toBeGreaterThan(0);
  });
});
