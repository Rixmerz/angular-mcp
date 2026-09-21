import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class MetricService {
  private readonly http = inject(HttpClient);

  getMetrics(): Observable<unknown[]> {
    return this.http.get<unknown[]>('https://api.example.com/metrics');
  }
}
