import { Injectable, NgZone } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { BehaviorSubject, Observable, Subject, fromEventPattern } from 'rxjs';
import { tap } from 'rxjs/operators';
import { ApiService } from "./api.service";
import { RpcService } from "./rpc.service"
import { ENDPOINTS } from '../../../environments/endpoints.conf';
import { BalanceService } from "./balance.service"
import { AuthService } from "./auth.service"

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
  // NEW (optional): we won't require callers to pass these,
  // but if provided we’ll forward to BE.
  socketId?: string;
  obUrl?: string;
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
  constructor(private api: ApiService,
              private rpc: RpcService,
              private balance: BalanceService,
              private auth: AuthService
              ) {}
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

  withdraw(systemId: string, amount: number) {
    return this.mainApi.withdraw({ systemId, amount })
      .pipe(tap(() => this.fetchRunning().subscribe()));
  }

  uploadSystem(file: File, name?: string) {
     return new Observable<{ ok: boolean; systemId: string }>(observer => {
      const fr = new FileReader();
      fr.onerror = () => observer.error(new Error('Failed to read file'));
      fr.onload = () => {
        const base64 = (fr.result as string).split(',')[1]; // strip data:uri prefix
        this.mainApi.uploadAlgo({
          name: name || file.name,
          dataBase64: base64
        }).subscribe({
          next: (res) => { observer.next(res); observer.complete(); },
          error: (e) => observer.error(e)
        });
      };
      fr.readAsDataURL(file); // gives base64 reliably
    });
  }

  /**
   * Run a system (backward compatible).
   * - old usage: runSystem(systemId)
   * - new optional usage: runSystem(systemId, { socketId?, obUrl? })
   */
runSystem(systemId: string) {
  const network = String(this.rpc.NETWORK);           // <-- use the instance
  const cfg = ENDPOINTS[network as keyof typeof ENDPOINTS];

  // extract host & port from ws://host:port/ws
  const [hostPart] = cfg.orderbookApiUrl.split('/ws');
  const [, hostAndPort] = hostPart.split('://');
  const [host, port] = hostAndPort.split(':');

  const addr = this.auth.activeMainKey.address;       // <-- keep address
  const pub  = this.auth.activeMainKey.pubkey;        // <-- keep pubkey
  const test = network.includes('TEST');

  return this.mainApi.runAlgo({
    systemId,
    network,
    host,
    port,
    test,
    addr,
    pub,
  });
}



  stopSystem(systemId: string) {
    return this.mainApi.stopAlgo(systemId);
  }

  /**
   * Allocate exposure (backward compatible).
   * - old usage: allocate(systemId, amount)
   * - new optional usage: allocate(systemId, amount, { socketId?, obUrl?, counterVenue? })
   */
  allocate(systemId: string, amount: number, opts?: { socketId?: string; obUrl?: string; counterVenue?: AllocateRequest['counterVenue'] }) {
    return this.mainApi.allocate({
      systemId,
      amount,
      ...(opts?.counterVenue ? { counterVenue: opts.counterVenue } : {}),
      ...(opts?.socketId     ? { socketId: opts.socketId }         : {}),
      ...(opts?.obUrl        ? { obUrl: opts.obUrl }               : {}),
    });
  }
}
