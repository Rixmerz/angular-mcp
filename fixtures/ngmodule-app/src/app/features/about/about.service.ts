import { Injectable } from '@angular/core';

export interface AboutFact {
  label: string;
  value: string;
}

@Injectable()
export class AboutService {
  private readonly facts: AboutFact[] = [
    { label: 'Framework', value: 'Angular' },
    { label: 'Architecture', value: 'NgModule + standalone hybrid' },
    { label: 'Fixture', value: 'ngmodule-app' },
  ];

  getFacts(): AboutFact[] {
    return this.facts;
  }
}
