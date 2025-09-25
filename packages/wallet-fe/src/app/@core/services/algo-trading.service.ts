import { Injectable, NgZone } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { BehaviorSubject, Observable, Subject, fromEventPattern } from 'rxjs';
import { tap } from 'rxjs/operators';
import { ApiService } from "./api.service";

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
  constructor(private api: ApiService) {}
  // Adjust base if needed (e.g., '/api' behind Electron)
  private base = '/api/algo';

  /** Discovery (ranked systems) and running instances for current user */
  readonly discovery$ = new BehaviorSubject<DiscoveryRow[]>([]);
  readonly running$ = new BehaviorSubject<RunningSystem[]>([]);

  private metricStreams: Dict<Subject<MetricEvent>> = {};

  get mainApi() {
    return this.api.mainApi;
  }

  /** Fetch discovery list with optional filters */
  fetchDiscovery(filters: Dict) {
    return this.mainApi.fetchDiscovery(filters)
      .pipe(tap(rows => this.discovery$.next(rows)));
  }

  fetchRunning() {
    return this.mainApi.fetchRunning()
      .pipe(tap(list => this.running$.next(list)));
  }

  allocate(req: AllocateRequest) {
    return this.mainApi.allocate(req)
      .pipe(tap(() => this.fetchRunning().subscribe()));
  }

  withdraw(systemId: string, amount: number) {
    return this.mainApi.withdraw({ systemId, amount })
      .pipe(tap(() => this.fetchRunning().subscribe()));
  }

  uploadSystem(file: File, name?: string) {
    const form = new FormData();
    form.append('file', file, file.name);
    if (name) form.append('name', name);
    return this.mainApi.uploadAlgo(form);
  }

  runSystem(systemId: string) {
    return this.mainApi.runAlgo(systemId);
  }

  stopSystem(systemId: string) {
    return this.mainApi.stopAlgo(systemId);
  }

  allocate(systemId: string, amount: number) {
    return this.mainApi.allocateAlgo(systemId, amount);
  }
}
