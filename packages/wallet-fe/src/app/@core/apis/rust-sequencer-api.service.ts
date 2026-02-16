import { HttpClient } from "@angular/common/http";
import { Injectable } from "@angular/core";
import { Observable } from "rxjs";
import { environment } from "src/environments/environment";

export interface RustSequencerStatus {
  running: boolean;
  pid?: number;
  port?: number;
  wsPath?: string;
  wsUrl?: string;
  dataDir?: string;
  exePath?: string;
  args?: string;
  startedAtMs?: number;
  lastExit?: { code: number | null; signal: string | null; atMs: number };
  logsTail?: string[];
}

export interface RustSequencerStartRequest {
  exePath?: string;
  args?: string;
  port?: number;
  wsPath?: string;
  dataDir?: string;
}

@Injectable({ providedIn: 'root' })
export class RustSequencerApiService {
  constructor(private http: HttpClient) {}

  private get apiUrl() {
    return environment.homeApiUrl + '/api/';
  }

  status(): Observable<{ data?: RustSequencerStatus; error?: string }> {
    return this.http.get<{ data?: RustSequencerStatus; error?: string }>(this.apiUrl + 'rust/status');
  }

  start(req: RustSequencerStartRequest): Observable<{ data?: RustSequencerStatus; error?: string }> {
    return this.http.post<{ data?: RustSequencerStatus; error?: string }>(this.apiUrl + 'rust/start', req || {});
  }

  stop(): Observable<{ data?: RustSequencerStatus; error?: string }> {
    return this.http.post<{ data?: RustSequencerStatus; error?: string }>(this.apiUrl + 'rust/stop', {});
  }
}

