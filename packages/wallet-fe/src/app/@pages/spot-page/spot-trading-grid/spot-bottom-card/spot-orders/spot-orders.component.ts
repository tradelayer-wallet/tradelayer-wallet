import { Component, OnInit, OnDestroy } from '@angular/core';
import { Subscription } from 'rxjs';

import { AuthService } from 'src/app/@core/services/auth.service';
import { obEventPrefix, SocketService } from 'src/app/@core/services/socket.service';
import { ISpotOrder } from 'src/app/@core/services/spot-services/spot-orderbook.service';
import { SpotOrdersService } from 'src/app/@core/services/spot-services/spot-orders.service';

@Component({
  selector: 'tl-spot-orders',
  templateUrl: './spot-orders.component.html',
  styleUrls: ['./spot-orders.component.scss']
})
export class SpotOrdersComponent implements OnInit, OnDestroy {
  private subsArray: Subscription[] = [];

  displayedColumns: string[] = ['date', 'market', 'amount', 'price', 'isBuy', 'close'];

  constructor(
    private spotOrdersService: SpotOrdersService,
    private socketService: SocketService,
    private authService: AuthService,
  ) {}

  get socket(): any {
    return this.socketService.socket;
  }

  get openedOrders() {
    return this.spotOrdersService.openedOrders;
  }

  closeOrder(uuid: string) {
    this.spotOrdersService.closeOpenedOrder(uuid);
  }

  ngOnInit(): void {
    this.subscribeToSocket();
  }

  ngOnDestroy(): void {
    this.subsArray.forEach(s => s.unsubscribe());
  }

  // ----- symbol classification -----
  private classifySymbol(sym: string): 'SPOT' | 'FUTURES' | 'UNKNOWN' {
    if (!sym) return 'UNKNOWN';
    if (/^\d+-\d+$/.test(sym)) return 'SPOT';              // e.g. "0-5"
    if (/^\d+$/.test(sym)) return 'FUTURES';               // e.g. "5"
    if ((sym.match(/-/g) || []).length >= 2) return 'FUTURES';
    if (/-FUT\b/i.test(sym)) return 'FUTURES';
    if (/(?:^|-)C(?:-|$)/i.test(sym) || /(?:^|-)P(?:-|$)/i.test(sym)) return 'FUTURES';
    return 'UNKNOWN';
  }
  private isSpotSymbol(sym: string)    { return this.classifySymbol(sym) === 'SPOT'; }
  private isFuturesSymbol(sym: string) { return this.classifySymbol(sym) === 'FUTURES'; }

  // ----- legacy mappers (what the UI tables expect) -----
  private toLegacyOpen(o: any, desk: 'SPOT'|'FUTURES') {
  const key = desk === 'SPOT' ? this.authService.activeSpotKey
                              : this.authService.activeFuturesKey;

  // Derive a display name if you have a symbol→name map; fall back to symbol
  const marketName = (o.marketName ?? o.symbol ?? '-');

  return {
    // legacy / existing fields
    uuid:       o.uuid,
    engine_id:  o.engine_id,
    price:      String(o.price),
    amount:     String(o.amount),
    side:       o.side,
    marketKey:  o.symbol,
    timestamp:  o.timestamp,
    type:       desk,
    state:      'OPEN',
    keypair:    key,

    // 👇 add what the Orders table template actually binds to
    action:     o.side,                    // used by {{ element.action }}
    marketName,                            // used by {{ element.marketName || '-' }}
    props: {                               // used by {{ element.props.amount/price }}
      amount: String(o.amount ?? 0),
      price:  String(o.price  ?? 0),
    },
  };
}


  private toLegacyHist(e: any, desk: 'SPOT'|'FUTURES') {
    const key = desk === 'SPOT' ? this.authService.activeSpotKey
                                : this.authService.activeFuturesKey;
    const qty = e.qty ?? e.quantity ?? e.resting_qty ?? 0;
    const price = e.price ?? 0;
    return {
      uuid:       e.uuid,
      marketKey:  e.symbol,
      side:       e.side,
      timestamp:  e.ts ?? e.timestamp,
      action:     e.side,                // template uses element.action
      state:      e.event,               // SUBMIT_ACK | RESTED | MATCH | FILLED | ...
      props: {                           // template uses element.props.amount/price
        amount: String(qty),
        price:  String(price),
      },
      type:       desk,
      keypair:    key,
    };
  }

  // ---- internals ----
  private subscribeToSocket(): void {
    const sock = this.socket;
    if (!sock) return;

    // placed-orders -> { openedOrders: [], orderHistory: [] } in *new* native shape
    sock.on(`${obEventPrefix}::placed-orders`, (msg: any) => {
      console.log('raw order payload '+JSON.stringify(msg))
        const opened = Array.isArray(msg?.openedOrders) ? msg.openedOrders : [];
        const hist = typeof msg?.orderHistory === 'string'
          ? JSON.parse(msg.orderHistory)
          : (Array.isArray(msg?.orderHistory) ? msg.orderHistory : []);

      const openedSpot = opened
        .filter((o: any) => this.isSpotSymbol(o.symbol))
        .map((o: any) => this.toLegacyOpen(o, 'SPOT'));

      const historySpot = hist
        .filter((e: any) => this.isSpotSymbol(e.symbol))
        .map((e: any) => this.toLegacyHist(e, 'SPOT'));
        console.log('formatted '+JSON.stringify(openedSpot)+' '+' formatted history '+JSON.stringify(historySpot))
      this.spotOrdersService.openedOrders  = openedSpot;
      this.spotOrdersService.orderHistory  = historySpot; // full history
    });

    // clear on disconnect
    sock.on(`${obEventPrefix}::disconnect`, () => {
      this.spotOrdersService.openedOrders = [];
    });

    // react to address changes
    const subs = this.authService.updateAddressesSubs$.subscribe((kp: any) => {
      if (!this.authService.activeSpotKey || !kp?.length) {
        this.spotOrdersService.closeAllOrders();
      }
    });
    this.subsArray.push(subs);
  }
}
