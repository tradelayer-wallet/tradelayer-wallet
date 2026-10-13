import { HttpEvent, HttpHandler, HttpInterceptor, HttpRequest } from "@angular/common/http";
import { Injectable } from "@angular/core";
import { Observable, from } from "rxjs";
import { switchMap } from "rxjs/operators";
import { environment } from "src/environments/environment";
import { getLocalAuthToken } from "src/app/utils/local-auth.util";

// Attaches the per-session auth token (`x-tl-auth` header) to every request
// sent to the local wallet server; without it the server responds 403.
@Injectable()
export class LocalAuthInterceptor implements HttpInterceptor {

    intercept(req: HttpRequest<any>, next: HttpHandler): Observable<HttpEvent<any>> {
        if (!req.url.startsWith(environment.homeApiUrl)) return next.handle(req);
        return from(getLocalAuthToken()).pipe(
            switchMap(token => {
                if (!token) return next.handle(req);
                const authReq = req.clone({ setHeaders: { 'x-tl-auth': token } });
                return next.handle(authReq);
            }),
        );
    }
}
