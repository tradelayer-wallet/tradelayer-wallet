// src/app/@core/services/futures-services/futures-channels.service.ts
import { Injectable } from '@angular/core';
import axios, { AxiosResponse } from 'axios';
import { BehaviorSubject } from 'rxjs';
import { AuthService } from 'src/app/@core/services/auth.service';
import { FuturesMarketService } from 'src/app/@core/services/futures-services/futures-markets.service';

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

type FutOverride = { address?: string; collateralPropertyId?: number };

@Injectable({ providedIn: 'root' })
export class FuturesChannelsService {
  public channelsCommits: ChannelBalanceRow[] = [];

  private readonly endpoint = 'http://localhost:3000/tl_channelBalanceForCommiter';
  private pollId?: any;
  private isLoading = false;
  private refreshMs = 20000;

  private __rows$ = new BehaviorSubject<ChannelBalanceRow[]>([]);
  private __override: FutOverride | null = null;

  constructor(
    private auth: AuthService,
    private futMarkets: FuturesMarketService
  ) {}

  // ---------- Polling API ----------
  startPolling(ms = 20000) {
    this.refreshMs = Math.max(1000, ms | 0);

    if (this.pollId) {
      clearInterval(this.pollId);
      this.pollId = undefined;
    }

    this.pollId = setInterval(() => this.loadOnce(), this.refreshMs);

    this.loadOnce();
  }

  stopPolling(): void {
    if (this.pollId) clearInterval(this.pollId);
    this.pollId = undefined;
  }

  refreshNow(): void { this.loadOnce(); }

  // ---------- Core fetch ----------
  public async loadOnce(): Promise<void> {
    if (this.isLoading) return;
    this.isLoading = true;

    try {
      const address =
        this.__override?.address ??
        this.auth.walletAddresses?.[0];

      const market: any = this.futMarkets?.selectedMarket;
      const collateralPropertyId =
        this.__override?.collateralPropertyId ??
        market?.collateral?.propertyId;

      if (!address || !Number.isFinite(Number(collateralPropertyId))) {
        this.channelsCommits = [];
        this.__rows$.next([]);
        return;
      }

      const res: AxiosResponse<ChannelBalancesResponse | any> =
        await axios.get(this.endpoint, {
          params: {
            address,
            propertyId: Number(collateralPropertyId),
          },
        });

      const rawRows: any[] =
        Array.isArray(res.data)
          ? res.data
          : Array.isArray(res.data?.rows)
            ? res.data.rows
            : [];

      const rows = rawRows.map(r =>
        this.normalizeRow(r, address, Number(collateralPropertyId))
      );

      this.channelsCommits = rows.slice();
      this.__rows$.next(this.channelsCommits);
    } catch (err) {
      console.error('[FuturesChannelsService] load error:', err);
      this.channelsCommits = [];
      this.__rows$.next([]);
    } finally {
      this.isLoading = false;
    }
  }

  refreshFuturesChannels(): void {
  this.loadOnce();
}


  private normalizeRow(
    r: any,
    addr: string,
    collateralPropertyId: number
  ): ChannelBalanceRow {
    const participants: { A?: string; B?: string } = r?.participants ?? {
      A: r?.participantA ?? r?.A ?? r?.partyA,
      B: r?.participantB ?? r?.B ?? r?.partyB,
    };

    let column: 'A' | 'B';
    if (r?.column === 'A' || r?.column === 'B') column = r.column;
    else if (participants?.A === addr) column = 'A';
    else if (participants?.B === addr) column = 'B';
    else column = 'A';

    const counterparty = column === 'A' ? participants?.B : participants?.A;

    const amount = Number(r?.amount ?? r?.balance ?? r?.value ?? 0);
    const lcb = Number(r?.lastCommitmentBlock ?? r?.block ?? r?.height ?? NaN);

    const channelId =
      r?.channel ??
      r?.channelId ??
      `${participants?.A ?? ''}:${participants?.B ?? ''}`;

    return {
      channel: String(channelId),
      column,
      propertyId: collateralPropertyId,
      amount,
      participants,
      counterparty,
      lastCommitmentBlock: Number.isFinite(lcb) ? lcb : undefined,
    };
  }
}
