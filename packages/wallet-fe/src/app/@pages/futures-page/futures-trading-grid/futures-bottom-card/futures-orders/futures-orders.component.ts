import { Component, OnInit, OnDestroy } from '@angular/core';
import { AuthService } from 'src/app/@core/services/auth.service';
import { obEventPrefix, SocketService } from 'src/app/@core/services/socket.service';
import { Subscription } from 'rxjs';
import { FuturesOrdersService } from 'src/app/@core/services/futures-services/futures-orders.service';
import { IFuturesOrder } from 'src/app/@core/services/futures-services/futures-orderbook.service';

@Component({
  selector: 'tl-futures-orders',
  templateUrl: '../../../../spot-page/spot-trading-grid/spot-bottom-card/spot-orders/spot-orders.component.html',
  styleUrls: ['../../../../spot-page/spot-trading-grid/spot-bottom-card/spot-orders/spot-orders.component.scss']
})
export class FuturesOrdersComponent implements OnInit, OnDestroy {
  private subsArray: Subscription[] = [];

  displayedColumns: string[] = ['date', 'market', 'amount', 'price', 'isBuy', 'close'];

  constructor(
    private futuresOrdersService: FuturesOrdersService,
    private socketService: SocketService,
    private authService: AuthService,
  ) {}

  get socket(): any {
    return this.socketService.socket;
  }

  get openedOrders() {
    return this.futuresOrdersService.openedOrders;
  }

  closeOrder(uuid: string) {
    this.futuresOrdersService.closeOpenedOrder(uuid);
  }

  ngOnInit() {
    this.subscribe();
  }

  ngOnDestroy(): void {
    this.subsArray.forEach(s => s.unsubscribe());
  }

  // ----- symbol classification -----
  private classifySymbol(sym: string): 'SPOT' | 'FUTURES' | 'UNKNOWN' {
    if (!sym) return 'UNKNOWN';

    // SPOT → "0-5"
    if (/^\d+-\d+$/.test(sym)) return 'SPOT';

    // FUTURES → "3-perp", "5-perp"
    if (/^\d+-perp$/i.test(sym)) return 'FUTURES';

    // FUTURES → plain contractId number "5"
    if (/^\d+$/.test(sym)) return 'FUTURES';

    // FUTURES → multi-segment "3-btc-perp"
    if (/perp$/i.test(sym)) return 'FUTURES';

    // existing fallbacks:
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
      collateral: o.collateral ?? o.props?.collateral,
      margin: o.margin ?? o.props?.margin ?? o.props?.initMargin,
      contract_id: o.contract_id ?? o.props?.contract_id,
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
      action:     e.side,
      state:      e.event,
      props: {
        amount: String(qty),
        price:  String(price),
      },
      type:       desk,
      keypair:    key,
    };
  }

  private subscribe() {
    const sock = this.socket;
    if (!sock) return;

    sock.on(`${obEventPrefix}::placed-orders`, (msg: any) => {
      const opened = Array.isArray(msg?.openedOrders) ? msg.openedOrders : [];
      const hist = typeof msg?.orderHistory === 'string'
        ? JSON.parse(msg.orderHistory)
        : (Array.isArray(msg?.orderHistory) ? msg.orderHistory : []);

      const openedFut = opened
        .filter((o: any) => this.isFuturesSymbol(o.symbol))
        .map((o: any) => this.toLegacyOpen(o, 'FUTURES'));

      const historyFut = hist
        .filter((e: any) => this.isFuturesSymbol(e.symbol))
        .map((e: any) => this.toLegacyHist(e, 'FUTURES'));

      this.futuresOrdersService.openedOrders = openedFut;
      this.futuresOrdersService.orderHistory = historyFut; // full history
    });

    sock.on(`${obEventPrefix}::disconnect`, () => {
      this.futuresOrdersService.openedOrders = [];
    });

    const subs = this.authService.updateAddressesSubs$.subscribe((kp: any) => {
      if (!this.authService.activeFuturesKey || !kp?.length) {
        this.futuresOrdersService.closeAllOrders();
      }
    });
    this.subsArray.push(subs);
  }
}
