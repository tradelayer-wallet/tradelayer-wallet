import { Injectable, NgZone } from "@angular/core";
import { Subject, BehaviorSubject } from "rxjs";
import { obEventPrefix, SocketService } from "../socket.service";
import { ToastrService } from "ngx-toastr";
import { LoadingService } from "../loading.service";
import { AuthService } from "../auth.service";
import { FuturesMarketService } from "./futures-markets.service";
import { ITradeInfo } from "src/app/utils/swapper";
import { IFuturesTradeProps } from "src/app/utils/swapper/common";
import { wrangleObMessageInPlace } from "src/app/@core/utils/ob-normalize";

// ---------------- types ----------------
type Side = "bids" | "asks" | "both";

export interface IFuturesHistoryTrade extends ITradeInfo<IFuturesTradeProps> {
  txid: string;
  side?: "SELL" | "BUY";
}

export interface IFuturesOrder {
  action: "SELL" | "BUY";
  keypair: {
    address: string;
    pubkey: string;
  };
  lock: boolean;
  props: {
    amount: number;
    contract_id: number;
    price: number;
    leverage: number;
    collateral: number;
  };
  socket_id: string;
  timestamp: number;
  type: "FUTURES";
  uuid: string;
  state?: "CANCELED" | "FILLED";
}

@Injectable({ providedIn: "root" })
export class FuturesOrderbookService {
  // --- state / streams consumed by the futures orderbook card ---
  private activeKey: string | null = null; // numeric string, e.g. "3"
  private _lastObTs = 0; // optional: last-write-wins guard

  outsidePriceHandler: Subject<number> = new Subject();
  buyOrderbooks$ = new BehaviorSubject<{ amount: number; price: number }[]>([]);
  sellOrderbooks$ = new BehaviorSubject<{ amount: number; price: number }[]>([]);
  tradeHistory: IFuturesHistoryTrade[] = [];
  currentPrice = 1;

  // optional render nudge hook: component sets this to cdr.detectChanges()
  onUpdate?: () => void;

  // legacy row buffer (kept only for fallback when server sends arrays)
  private _rawOrderbookData: IFuturesOrder[] = [];

  constructor(
    private socketService: SocketService,
    private futuresMarketService: FuturesMarketService,
    private toastrService: ToastrService,
    private loadingService: LoadingService,
    private authService: AuthService,
    private ngZone: NgZone
  ) {}

  // ---------------- getters ----------------
  private get socket() {
    return this.socketService.socket;
  }

  // ---------------- key normalization ----------------
  /** Extract numeric futures key from payload: "3-perp" -> "3". */
  private normalizeInboundKeyForFutures(msg: any): string | null {
    const sym: string | undefined =
      msg?.orders?.symbol ?? msg?.marketKey ?? msg?.symbol;
    if (typeof sym !== "string") return null;
    const m = sym.match(/^(\d+)-perp$/i);
    return m ? m[1] : null;
  }

  // ---------------- public API ----------------
  /** Call when switching/joining a futures market (contract_id). */
  switchFuturesMarket(
    contract_id: number,
    opts?: { depth?: number; side?: Side; includeTrades?: boolean }
  ) {
    const id = Number(contract_id);
    if (!Number.isFinite(id)) return;

    const symbol = `${id}-perp`;
    this.activeKey = String(id);

    // leave old (ok if not joined)
    this.socket.emit("orderbook:leave", { marketKey: symbol });

    // join + request snapshot using the format your FE renders
    this.socket.emit("orderbook:join", { marketKey: symbol });
    this.socket.emit("update-orderbook", {
      type: "FUTURES",
      contract_id: id,
      depth: String(opts?.depth ?? 50),
      side: opts?.side ?? "both",
      includeTrades: String(opts?.includeTrades ?? false),
      marketKey: symbol,
    });
  }

  /** Wire socket listeners once (idempotent). */
  subscribeForOrderbook() {
    this.endOrderbookSubscription();

    // Connected (optional toast)
    this.socket.on(`${obEventPrefix}::connected`, (msg: any) => {
      this.ngZone.run(() => {
        try {
          this.toastrService.success("Connected to orderbook server");
        } catch {}
      });
    });

    // Errors
    this.socket.on(`${obEventPrefix}::order:error`, (message: string) => {
      this.ngZone.run(() => {
        this.toastrService.error(message || "Undefined Error", "Orderbook Error");
        this.loadingService.tradesLoading = false;
      });
    });

    // Disconnect: clear in-memory (keep any localStorage cache if you use one)
    this.socket.on(`${obEventPrefix}::disconnect`, () => {
      this.ngZone.run(() => {
        this._rawOrderbookData = [];
        this.buyOrderbooks$.next([]);
        this.sellOrderbooks$.next([]);
        this.tradeHistory = [];
        this.currentPrice = 1;
        this.toastrService.info("Disconnected from orderbook server. Orders cleared.");
        this.onUpdate?.();
      });
    });

    // Server requesting a refresh
    this.socket.on(`${obEventPrefix}::update-orders-request`, () => {
      this.ngZone.run(() => {
        const id = Number(this.activeKey);
        if (!Number.isFinite(id)) return;
        this.socket.emit("update-orderbook", {
          type: "FUTURES",
          contract_id: id,
          depth: "50",
          side: "both",
          includeTrades: "false",
          marketKey: `${id}-perp`,
        });
      });
    });

    // Main orderbook stream
    this.socket.on(`${obEventPrefix}::orderbook-data`, (orderbookData: any) => {
      this.ngZone.run(() => {
        // Normalize / sanitize
        let msg = wrangleObMessageInPlace(orderbookData) ?? orderbookData;

        // 0) Ignore bogus empty full-snapshot that sometimes precedes the real one
        if (Array.isArray(msg?.orders) && !msg?.isDelta && msg.orders.length === 0) {
          return;
        }

        // 1) Market key guard
        const inboundKey = this.normalizeInboundKeyForFutures(msg) ?? this.activeKey;
        if (!inboundKey) return;
        if (this.activeKey && inboundKey !== this.activeKey) return;

        // 2) Last-write-wins (optional, but helps with out-of-order packets)
        const ts = Number(msg?.orders?.timestamp ?? msg?.timestamp ?? Date.now());
        if (ts < this._lastObTs) return;
        this._lastObTs = ts;

        // 3) SNAPSHOT OBJECT PATH: { orders: { symbol, bids, asks, ... } }
        if (msg?.orders && !Array.isArray(msg.orders)) {
          const book = msg.orders as { bids?: any[]; asks?: any[] };
          const toRows = (arr?: any[]) =>
            (arr ?? [])
              .map((l) => ({
                price: Number(l.price) || 0,
                amount: Math.abs(Number(l.amount)) || 0,
              }))
              .filter((r) => r.price > 0 && r.amount > 0);

          // Emit NEW references so | async picks them up
          this.buyOrderbooks$.next(toRows(book.bids));
          this.sellOrderbooks$.next(toRows(book.asks));

          // Optional quick price
          const bestAsk = this.sellOrderbooks$.value[0]?.price;
          const bestBid = this.buyOrderbooks$.value[0]?.price;
          this.currentPrice = bestAsk ?? bestBid ?? 1;

          // History if provided
          this.tradeHistory = Array.isArray(msg.history) ? msg.history : [];
          this.onUpdate?.();
          return;
        }

        // 4) LEGACY ARRAY PATH (if server sometimes sends rows)
        if (Array.isArray(msg.orders)) {
          const rows = msg.orders as IFuturesOrder[];
          const buys = rows
            .filter((r) => r?.action === "BUY" && r?.props)
            .map((r) => ({ price: Number(r.props.price) || 0, amount: Math.abs(Number(r.props.amount)) || 0 }))
            .filter((r) => r.price > 0 && r.amount > 0);

          const sells = rows
            .filter((r) => r?.action === "SELL" && r?.props)
            .map((r) => ({ price: Number(r.props.price) || 0, amount: Math.abs(Number(r.props.amount)) || 0 }))
            .filter((r) => r.price > 0 && r.amount > 0);

          this.buyOrderbooks$.next(buys);
          this.sellOrderbooks$.next(sells);

          const bestAsk = this.sellOrderbooks$.value[0]?.price;
          const bestBid = this.buyOrderbooks$.value[0]?.price;
          this.currentPrice = bestAsk ?? bestBid ?? 1;

          this.tradeHistory = Array.isArray(msg.history) ? msg.history : [];
          this.onUpdate?.();
        }
      });
    });
  }

  /** Unbind all OB listeners (idempotent). */
  endOrderbookSubscription() {
    [
      "connected",
      "disconnect",
      "order:error",
      "order:saved",
      "update-orders-request",
      "orderbook-data",
    ].forEach((m) => this.socket.off(`${obEventPrefix}::${m}`));
  }
}
