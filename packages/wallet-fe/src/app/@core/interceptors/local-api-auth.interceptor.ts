import { Injectable } from '@angular/core';
import {
    HttpEvent,
    HttpHandler,
    HttpInterceptor,
    HttpRequest,
} from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from 'src/environments/environment';
import { ElectronService } from '../services/electron.service';

const LOCAL_AUTH_QUERY_KEY = 'tl_auth';

@Injectable()
export class LocalApiAuthInterceptor implements HttpInterceptor {
    constructor(
        private electronService: ElectronService,
    ) {}

    intercept(request: HttpRequest<unknown>, next: HttpHandler): Observable<HttpEvent<unknown>> {
        const token = this.electronService.getLocalApiToken();
        if (!token || !request.url.startsWith(environment.homeApiUrl)) {
            return next.handle(request);
        }

        if (request.params.has(LOCAL_AUTH_QUERY_KEY)) {
            return next.handle(request);
        }

        return next.handle(request.clone({
            setParams: {
                [LOCAL_AUTH_QUERY_KEY]: token,
            },
        }));
    }
}
