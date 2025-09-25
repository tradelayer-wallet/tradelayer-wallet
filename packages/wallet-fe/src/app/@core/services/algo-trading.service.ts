import { Injectable, NgZone } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { BehaviorSubject, Observable, Subject, fromEventPattern } from 'rxjs';
import { tap } from 'rxjs/operators';

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

type Dict<T = any> = { [k: string]: T };

@Injectable({ providedIn: 'root' })
export class AlgoTradingService {
  // Adjust base if needed (e.g., '/api' behind Electron)
  private base = '/api/algo';

  /** Discovery (ranked systems) and running instances for current user */
  readonly discovery$ = new BehaviorSubject<DiscoveryRow[]>([]);
  readonly running$ = new BehaviorSubject<RunningSystem[]>([]);

  private metricStreams: Dict<Subject<MetricEvent>> = {};

  constructor(private http: HttpClient, private zone: NgZone) {}

  /** Upload a trading system bundle (zip/js/ts) */
  uploadSystem(
    file: File,
    name?: string,
    isPublic?: boolean
  ): Observable<{ ok: boolean; systemId: string }> {
    const form = new FormData();
    form.append('file', file, file.name);
    if (name) form.append('name', name);
    form.append('public', String(!!isPublic));
    return this.http.post<{ ok: boolean; systemId: string }>(
      `${this.base}/systems`,
      form
    );
  }

  /** Fetch discovery list with optional filters */
  fetchDiscovery(filters: Dict): Observable<DiscoveryRow[]> {
    let params = new HttpParams();
    Object.entries(filters || {}).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== '') {
        params = params.set(k, String(v));
      }
    });
    return this.http
      .get<DiscoveryRow[]>(`${this.base}/discovery`, { params })
      .pipe(tap(rows => this.discovery$.next(rows)));
  }

  /** Fetch currently running systems for the user */
  fetchRunning(): Observable<RunningSystem[]> {
    return this.http
      .get<RunningSystem[]>(`${this.base}/running`)
      .pipe(tap(list => this.running$.next(list)));
  }

  /** Start/allocate a run */
  allocate(req: AllocateRequest): Observable<AllocateResponse> {
    return this.http
      .post<AllocateResponse>(`${this.base}/allocate`, req)
      .pipe(tap(() => this.fetchRunning().subscribe()));
  }

  /** Stop a run */
  stop(runId: string): Observable<{ ok: boolean }> {
    return this.http
      .post<{ ok: boolean }>(`${this.base}/stop`, { runId })
      .pipe(tap(() => this.fetchRunning().subscribe()));
  }

  /** Withdraw funds */
  withdraw(runId: string, amount: number): Observable<WithdrawResponse> {
    return this.http
      .post<WithdrawResponse>(`${this.base}/withdraw`, { runId, amount })
      .pipe(tap(() => this.fetchRunning().subscribe()));
  }

  /** Live metrics via SSE (fallback to polling) */
  metrics(runId: string): Observable<MetricEvent> {
    if (!this.metricStreams[runId]) {
      this.metricStreams[runId] = new Subject<MetricEvent>();
      const sseUrl = `${this.base}/metrics/stream?runId=${encodeURIComponent(runId)}`;

      try {
        const es = new EventSource(sseUrl, { withCredentials: true });
        const onMessage = (ev: MessageEvent) => {
          try {
            const data = JSON.parse(ev.data) as MetricEvent;
            this.zone.run(() => this.metricStreams[runId].next(data));
          } catch {
            /* ignore bad frames */
          }
        };
        const onError = () => { /* server may close, client stays alive */ };
        es.addEventListener('message', onMessage);
        es.addEventListener('error', onError);
      } catch {
        // Polling fallback
        const poll = () => {
          this.http
            .get<MetricEvent | MetricEvent[]>(
              `${this.base}/metrics`,
              { params: new HttpParams().set('runId', runId) }
            )
            .subscribe((res: any) => {
              const arr = Array.isArray(res) ? res : [res];
              arr.forEach(m => this.metricStreams[runId].next(m));
              setTimeout(poll, 5000);
            });
        };
        poll();
      }
    }
    return this.metricStreams[runId].asObservable();
  }

  /** Stream user trade events to backfill trade history/PNL */
  userTrades(): Observable<any> {
    const url = `${this.base}/trades/stream`;
    const add = (handler: any) => {
      const es = new EventSource(url, { withCredentials: true }) as any;
      es.__ref = es;
      es.addEventListener('message', (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data);
          this.zone.run(() => handler(data));
        } catch {}
      });
    };
    const remove = (handler: any, signal?: any) => {
      const es = (signal as any)?.__ref;
      if (es) es.close();
    };
    return fromEventPattern(add, remove);
  }
}
