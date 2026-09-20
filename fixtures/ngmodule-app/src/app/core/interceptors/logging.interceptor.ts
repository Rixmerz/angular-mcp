import { Injectable } from '@angular/core';
import {
  HttpEvent,
  HttpHandler,
  HttpInterceptor,
  HttpRequest,
} from '@angular/common/http';
import { Observable, tap } from 'rxjs';

@Injectable()
export class LoggingInterceptor implements HttpInterceptor {
  intercept(
    req: HttpRequest<unknown>,
    next: HttpHandler
  ): Observable<HttpEvent<unknown>> {
    const started = Date.now();
    return next.handle(req).pipe(
      tap(() =>
        console.log(
          `[LoggingInterceptor] ${req.method} ${req.urlWithParams} (${Date.now() - started}ms)`
        )
      )
    );
  }
}
