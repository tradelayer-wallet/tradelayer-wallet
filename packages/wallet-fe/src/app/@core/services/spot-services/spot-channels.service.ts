import { Injectable } from '@angular/core';
import axios, { AxiosResponse } from 'axios';
import { AuthService } from 'src/app/@core/services/auth.service';
import { SpotMarketsService } from 'src/app/@core/services/spot-services/spot-markets.service';

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

@Injectable({ providedIn: 'root' })
export class SpotChannelsService {
  /** UI binds to this */
  public channelsCommits: ChannelBalanceRow[] = [];

  /** Hardcoded endpoint */
  private readonly endpoint = 'http://localhost:3000/tl_channelBalanceForCommiter';

  /** polling */
  private refreshMs = 20000;
  private pollId?: any;
  private isLoading = false;

  constructor(
    private authService: AuthService,
    private spotMarkets: SpotMarketsService
  ) {
    // Optional: live refresh on address/market change if streams exist
    this.authService.updateAddressesSubs$?.subscribe(() => this.refreshNow());
    (this.spotMarkets as any).selectedMarket$?.subscribe?.(() => this.refreshNow());
    (this.spotMarkets as any).marketChange$?.subscribe?.(() => this.refreshNow());
  }

  /** Start (or restart) polling */
  startPolling(ms: number = this.refreshMs): void {
    this.stopPolling();
    this.refreshMs = Math.max(1000, ms | 0);
    this.loadOnce(); // run immediately
    this.pollId = setInterval(() => this.loadOnce(), this.refreshMs);
  }

  /** Stop polling */
  stopPolling(): void {
    if (this.pollId) clearInterval(this.pollId);
    this.pollId = undefined;
  }

  /** Manual refresh */
  refreshNow(): void {
    this.loadOnce();
  }

  /** Change cadence */
  setRefreshMs(ms: number): void {
    this.refreshMs = Math.max(1000, ms | 0);
    if (this.pollId) this.startPolling(this.refreshMs);
  }

  // ---------- internals ----------

  private normalizeRow(
    r: any,
    addr: string,
    defaults: { propertyId?: number }
  ): ChannelBalanceRow {
    // participants can come in various shapes; normalize
    const participants: { A?: string; B?: string } = r?.participants ?? {
      A: r?.participantA ?? r?.A ?? r?.partyA,
      B: r?.participantB ?? r?.B ?? r?.partyB,
    };

    // Determine which side we are (prefer provided column, else infer)
    let column: 'A' | 'B';
    if (r?.column === 'A' || r?.column === 'B') {
      column = r.column;
    } else if (participants?.A && addr && participants.A === addr) {
      column = 'A';
    } else if (participants?.B && addr && participants.B === addr) {
      column = 'B';
    } else {
      column = 'A'; // fallback
    }

    const counterparty = column === 'A' ? participants?.B : participants?.A;

    // propertyId (0 is valid for LTC) — only replace if undefined/null
    const pidRaw = r?.propertyId;
    const propertyId =
      pidRaw !== undefined && pidRaw !== null ? Number(pidRaw)
      : defaults.propertyId !== undefined ? Number(defaults.propertyId)
      : 0;

    // amounts/blocks
    const amount = Number(
      r?.amount ?? r?.balance ?? r?.value ?? 0
    );

    const lastCommitmentBlock = Number(
      r?.lastCommitmentBlock ?? r?.block ?? r?.height ?? undefined
    );

    const channelId =
      r?.channel ??
      r?.channelId ??
      (participants?.A || participants?.B
        ? `${participants?.A ?? ''}:${participants?.B ?? ''}`
        : 'unknown');

    return {
      channel: String(channelId),
      column,
      propertyId,
      amount,
      participants,
      counterparty,
      lastCommitmentBlock: Number.isFinite(lastCommitmentBlock) ? lastCommitmentBlock : undefined,
    };
  }

  public async loadOnce(): Promise<void> {
    if (this.isLoading) return;
    this.isLoading = true;
    try {
      const addr = this.authService.walletAddresses?.[0];
      const m = this.spotMarkets.selectedMarket;

      // Use base/first token propertyId when not provided by backend (0 is valid)
      const pidRaw = m?.first_token?.propertyId;
      const defaultPid = pidRaw !== undefined && pidRaw !== null ? Number(pidRaw) : undefined;

      if (!addr) {
        this.channelsCommits = [];
        return;
      }

      const params: any = { address: addr };
      if (defaultPid !== undefined && Number.isFinite(defaultPid)) params.propertyId = defaultPid;

      const res: AxiosResponse<ChannelBalancesResponse | ChannelBalanceRow[] | any> =
        await axios.get(this.endpoint, { params });

      const data = res.data;
      const rawRows: any[] = Array.isArray(data) ? data : (Array.isArray(data?.rows) ? data.rows : []);
      const rows = rawRows.map(row => this.normalizeRow(row, addr, { propertyId: defaultPid }));

      // New array ref so Angular change detection triggers
      this.channelsCommits = rows.slice();
    } catch (err) {
      console.error('[spot-channels] load error:', err);
      this.channelsCommits = [];
    } finally {
      this.isLoading = false;
    }
  }

    get activeSpotaddress() {
        return this.authService.activeSpotKey?.address || null;
    }

    removeAll() {
        this.channelsCommits = [];
    }
}

