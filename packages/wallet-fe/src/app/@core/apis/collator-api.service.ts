import { HttpClient } from "@angular/common/http";
import { Injectable } from "@angular/core";
import { Observable } from "rxjs";
import { environment } from "src/environments/environment";

export interface CollatorStatus {
  running: boolean;
  pid?: number;
  port?: number;
  wsPath?: string;
  wsUrl?: string;
  dataDir?: string;
  entryPath?: string;
  startedAtMs?: number;
  lastExit?: { code: number | null; signal: string | null; atMs: number };
  logsTail?: string[];
}

export interface CollatorStartRequest {
  port?: number;
  wsPath?: string;
  dataDir?: string;
  entryPath?: string;
  clearlistEnforce?: boolean;
  clearlistUrl?: string | null;
  clearlistFailMode?: 'open' | 'closed';
  maxMsgBytes?: number;
  submitRps?: number;
  submitBurst?: number;
}

@Injectable({ providedIn: 'root' })
export class CollatorApiService {
  constructor(private http: HttpClient) {}

  private get apiUrl() {
    return environment.homeApiUrl + '/api/';
  }

  status(): Observable<{ data?: CollatorStatus; error?: string }> {
    return this.http.get<{ data?: CollatorStatus; error?: string }>(this.apiUrl + 'collator/status');
  }

  start(req: CollatorStartRequest): Observable<{ data?: CollatorStatus; error?: string }> {
    return this.http.post<{ data?: CollatorStatus; error?: string }>(this.apiUrl + 'collator/start', req || {});
  }

  stop(): Observable<{ data?: CollatorStatus; error?: string }> {
    return this.http.post<{ data?: CollatorStatus; error?: string }>(this.apiUrl + 'collator/stop', {});
  }
}

