// src/app/@core/services/futures-services/futures-channels.service.ts
import { Injectable } from '@angular/core';
import axios, { AxiosResponse } from 'axios';
import { BehaviorSubject, Observable } from 'rxjs';
import { AuthService } from 'src/app/@core/services/auth.service';
import { FuturesMarketService } from 'src/app/@core/services/futures-services/futures-markets.service';
// NOTE: avoid import path issues by typing as any
type FuturesMarketSvc = any;

export interface ChannelBalanceRow {
  channel: string;
  column: 'A' | 'B';
  propertyId: number;
  amount: number;
  participants?: { A?: string; B?: string };
  counterparty?: string;
  lastCommitmentBlock?: number;
}

export interface ChannelBalancesResponse {
  total: number;
  rows: ChannelBalanceRow[];
}

type FutOverride = { address?: string; contractId?: number; collateralPropertyId?: number };

@Injectable({ providedIn: 'root' })
export class FuturesChannelsService {
  public channelsCommits: ChannelBalanceRow[] = [];

  private readonly endpoint = 'http://localhost:3000/tl_futuresChannelBalanceForCommiter';
  private refreshMs = 20000;
  private pollId?: any;
  private isLoading = false;

  private __rows$ = new BehaviorSubject<ChannelBalanceRow[]>([]);
  private __override: FutOverride | null = null;

  constructor(
    private auth: AuthService,
    private futMarkets: FuturesMarketService
  ) {}

  refreshFuturesChannels(): void { this.refreshNow(); }

  ngOnInit() {
    this.refreshFuturesChannels()
  }

  // ---------- Polling API ----------
  startPolling(ms: number = this.refreshMs): void {
    this.stopPolling();
    this.refreshMs = Math.max(1000, ms | 0);
    this.loadOnce();
    this.pollId = setInterval(() => this.loadOnce(), this.refreshMs);
  }

  stopPolling(): void {
    if (this.pollId) clearInterval(this.pollId);
    this.pollId = undefined;
  }

  refreshNow(): void { this.loadOnce(); }

  setRefreshMs(ms: number): void {
    this.refreshMs = Math.max(1000, ms | 0);
    if (this.pollId) this.startPolling(this.refreshMs);
  }

  // ---------- Core fetch ----------
  public async loadOnce(): Promise<void> {
    if (this.isLoading) return;
    this.isLoading = true;
    try {
      const addr = this.__override?.address ?? this.auth.walletAddresses?.[0];
      const mAny = this.futMarkets?.selectedMarket as any;

      const fromMarket = this.extractIds(mAny);
      const contractId = this.__override?.contractId ?? fromMarket.contractId;
      const collateralPropertyId = this.__override?.collateralPropertyId ?? fromMarket.collateralPropertyId;

      const ok =
        !!addr &&
        contractId !== undefined && Number.isFinite(Number(contractId)) &&
        collateralPropertyId !== undefined && Number.isFinite(Number(collateralPropertyId));

      if (!ok) {
        this.channelsCommits = [];
        this.__rows__.next([]);
        return;
      }

      const res: AxiosResponse<ChannelBalancesResponse | ChannelBalanceRow[] | any> =
        await axios.get(this.endpoint, {
          params: { address: addr, propertyId: collateralPropertyId },
        });

        console.log('futures channels '+JSON.stringify(res))

      const data = res.data;
      const rawRows: any[] = Array.isArray(data) ? data : (Array.isArray(data?.rows) ? data.rows : []);
      const rows = rawRows.map(row => this.normalizeRow(row, addr, { collateralPropertyId }));

      this.channelsCommits = rows.slice();
      this.__rows__.next(this.channelsCommits);
    } catch (err) {
      console.error('[futures-channels] load error:', err);
      this.channelsCommits = [];
      this.__rows__.next([]);
    } finally {
      this.isLoading = false;
    }
  }

  private extractIds(m: any): { contractId?: number; collateralPropertyId?: number } {
    const cid =
      m?.contractId ?? m?.contract?.id ?? m?.contract?.propertyId ?? m?.propertyId ?? m?.id;
    const coll =
      m?.collateralPropertyId ?? m?.collateralId ?? m?.collateral?.propertyId ?? m?.marginAsset?.propertyId;
    return {
      contractId: cid !== undefined && cid !== null ? Number(cid) : undefined,
      collateralPropertyId: coll !== undefined && coll !== null ? Number(coll) : undefined,
    };
  }

  private normalizeRow(
    r: any,
    addr: string,
    defaults: { collateralPropertyId?: number }
  ): ChannelBalanceRow {
    const participants: { A?: string; B?: string } = r?.participants ?? {
      A: r?.participantA ?? r?.A ?? r?.partyA,
      B: r?.participantB ?? r?.B ?? r?.partyB,
    };

    let column: 'A' | 'B';
    if (r?.column === 'A' || r?.column === 'B') column = r.column;
    else if (participants?.A && participants.A === addr) column = 'A';
    else if (participants?.B && participants.B === addr) column = 'B';
    else column = 'A';

    const counterparty = column === 'A' ? participants?.B : participants?.A;

    const pidRaw = r?.propertyId ?? r?.collateralPropertyId;
    const propertyId =
      pidRaw !== undefined && pidRaw !== null
        ? Number(pidRaw)
        : (defaults.collateralPropertyId !== undefined ? Number(defaults.collateralPropertyId) : 0);

    const amount = Number(r?.amount ?? r?.balance ?? r?.value ?? 0);
    const lcb = Number(r?.lastCommitmentBlock ?? r?.block ?? r?.height ?? NaN);

    const channelId =
      r?.channel ?? r?.channelId ??
      (participants?.A || participants?.B ? `${participants?.A ?? ''}:${participants?.B ?? ''}` : 'unknown');

    return {
      channel: String(channelId),
      column,
      propertyId,
      amount,
      participants,
      counterparty,
      lastCommitmentBlock: Number.isFinite(lcb) ? lcb : undefined,
    };
  }

  private get __rows__() { return this.__rows$; }
}
