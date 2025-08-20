import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class AlgoTradingService {
  constructor(private http: HttpClient) {}

  uploadSystem(file: File, opts: { isPublic: boolean; name?: string }): Observable<void> {
    const form = new FormData();
    form.append('file', file);
    form.append('isPublic', String(opts.isPublic));
    if (opts.name) form.append('name', opts.name);
    return this.http.post<void>('/api/systems/upload', form);
  }
}
