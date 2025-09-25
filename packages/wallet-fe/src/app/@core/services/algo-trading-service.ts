import { Injectable, NgZone } from '@angular/core';
import { HttpClient, HttpParams, HttpHeaders } from '@angular/common/http';
import { BehaviorSubject, Observable, Subject, fromEventPattern } from 'rxjs';
import { map, tap } from 'rxjs/operators';

export interface DiscoveryRow {
  id: string;
  rank: number;
  market: string;
  mode: 'SPOT' | 'FUTURES';
  leverage?: string;
  roiPct: number;
  pnlUsd: number;
  copiers: number;
  runtime: string;
  meta?: any;
}

export interface RunningSystem {
  runId: string;
  name: string;
  allocated: number;
  pnl: number;
  startedAt: string | number | Date;
  counterVenuePct?: number;
}

export interface AllocateRequest {
  systemId: string;
  amount: number;
  counterVenue?: {
    name: string;
    apiKey?: string;
    apiSecret?: string;
  };
}

export interface AllocateResponse {
  runId: string;
  ok: boolean;
}

export interface WithdrawResponse {
  ok: boolean;
  balance?: number;
}

export interface MetricEvent {
  runId: string;
  ts: number;
  pnl: number;
  mdd?: number;
  sharpe?: number;
  trades?: number;
}

type Dict<T=any> = { [k: string]: T };

@Injectable({ providedIn: 'root' })
export class AlgoTradingService {
  private base = '/api/algo';

  discovery$ = new BehaviorSubject<DiscoveryRow[]>([]);
  running$ = new BehaviorSubject<RunningSystem[]>([]);

  // stream of per-run metric updates
  private metricStreams: Dict<Subject<MetricEvent>> = {};

  constructor(private http: HttpClient, private zone: NgZone) {}

  /** Upload a system as a file blob (JS/TS/ZIP). Server should store & compile if needed. */
  uploadSystem(file: File, name?: string, isPublic?: boolean): Observable<{ ok: boolean; systemId: string; }> {
    const form = new FormData();
    form.append('file', file, file.name);
    if (name) form.append('name', name);
    form.append('public', String(!!isPublic));
    return this.http.post<{ ok: boolean; systemId: string; }>(`${this.base}/systems`, form);
  }

  /** Fetch ranked discovery rows (server-backed), with optional filters. */
  fetchDiscovery(filters: Dict): Observable<DiscoveryRow[]> {
    let params = new HttpParams();
    Object.entries(filters || {}).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== '') params = params.set(k, String(v));
    });
    return this.http.get<DiscoveryRow[]>(`${this.base}/discovery`, { params })
      .pipe(tap(rows => this.discovery$.next(rows)));
  }

  /** Fetch running instances for current user. */
  fetchRunning(): Observable<RunningSystem[]> {
    return this.http.get<RunningSystem[]>(`${this.base}/running`)
      .pipe(tap(list => this.running$.next(list)));
  }

  /** Start/allocate a new run of a system. */
  allocate(req: AllocateRequest): Observable<AllocateResponse> {
    return this.http.post<AllocateResponse>(`${this.base}/allocate`, req).pipe(
      tap(() => this.fetchRunning().subscribe())
    );
  }

  /** Stop a running system. */
  stop(runId: string): Observable<{ ok: boolean; }> {
    return this.http.post<{ ok: boolean; }>(`${this.base}/stop`, { runId }).pipe(
      tap(() => this.fetchRunning().subscribe())
    );
  }

  /** Withdraw funds from a running system. */
  withdraw(runId: string, amount: number): Observable<WithdrawResponse> {
    return this.http.post<WithdrawResponse>(`${this.base}/withdraw`, { runId, amount }).pipe(
      tap(() => this.fetchRunning().subscribe())
    );
  }

  /** Stream live metrics for a run via SSE. Falls back to polling if SSE isn't available. */
  metrics(runId: string): Observable<MetricEvent> {
    if (!this.metricStreams[runId]) {
      this.metricStreams[runId] = new Subject<MetricEvent>();
      // Prefer SSE endpoint /metrics/stream?runId=...
      const url = `${this.base}/metrics/stream?runId=${encodeURIComponent(runId)}`;
      try {
        const es = new EventSource(url, { withCredentials: true });
        const onMessage = (ev: MessageEvent) => {
          try {
            const data = JSON.parse(ev.data);
            this.zone.run(() => this.metricStreams[runId].next(data));
          } catch {}
        };
        const onError = () => { /* server may close; client remains safe */ };
        es.addEventListener('message', onMessage);
        es.addEventListener('error', onError);
      } catch {
        // Fallback: poll
        const poll = () => {
          this.http.get<MetricEvent | MetricEvent[]>(`${this.base}/metrics`, { params: new HttpParams().set('runId', runId) })
            .subscribe((res: any) => {
              const list = Array.isArray(res) ? res : [res];
              list.forEach((m: MetricEvent) => this.metricStreams[runId].next(m));
              setTimeout(poll, 5000);
            });
        };
        poll();
      }
    }
    return this.metricStreams[runId].asObservable();
  }

  /** (Optional) Stream user trade events to fold into history/PnL in UI. */
  userTrades(): Observable<any> {
    const url = `${this.base}/trades/stream`;
    const addHandler = (handler: any) => {
      const es = new EventSource(url, { withCredentials: true });
      (es as any).__ref = es;
      es.addEventListener('message', (e) => {
        try {
          const data = JSON.parse(e.data);
          this.zone.run(() => handler(data));
        } catch {}
      });
    };
    const removeHandler = (handler: any, signal?: any) => {
      const es = (signal as any)?.__ref;
      if (es) es.close();
    };
    return fromEventPattern(addHandler, removeHandler);
  }
}
