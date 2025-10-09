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

    get socket() {
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
  return {
    uuid:       o.uuid,
    engine_id:  o.engine_id,
    price:      String(o.price),
    amount:     String(o.amount),
    side:       o.side,
    marketKey:  o.symbol,
    timestamp:  o.timestamp,
    type:       desk,              // << keeps your legacy filter happy
    state:      'OPEN',
    keypair:    key,
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
    // fields your Order History table reads:
    timestamp:  e.ts ?? e.timestamp,
    action:     e.side,                // the template shows element.action
    state:      e.event,               // SUBMIT_ACK | RESTED | MATCH | FILLED | ...
    props: {                           // template uses element.props.amount/price
      amount: String(qty),
      price:  String(price),
    },
    // keep legacy flags:
    type:       desk,
    keypair:    key,
  };
}


     private subscribe() {
  this.socket.on(
    `${obEventPrefix}::placed-orders`,
    this.socket.on(`${obEventPrefix}::placed-orders`, (msg: any) => {
    const opened = Array.isArray(msg?.openedOrders) ? msg.openedOrders : [];
    const hist = typeof msg?.orderHistory === 'string'
      ? JSON.parse(msg.orderHistory)
      : (Array.isArray(msg?.orderHistory) ? msg.orderHistory : []);

    const openedFut = opened
      .filter(o => this.isFuturesSymbol(o.symbol))
      .map(o => this.toLegacyOpen(o, 'FUTURES'));

    const historyFut = hist
      .filter(e => this.isFuturesSymbol(e.symbol))
      .map(e => this.toLegacyHist(e, 'FUTURES'));

    this.futuresOrdersService.openedOrders = openedFut;
    this.futuresOrdersService.orderHistory = historyFut; // full history
  });

    this.socket.on(`${obEventPrefix}::disconnect`, () => {
      this.futuresOrdersService.openedOrders = [];
    });

    const subs = this.authService.updateAddressesSubs$.subscribe(kp => {
      if (!this.authService.activeFuturesKey || !kp.length) {
        this.futuresOrdersService.closeAllOrders();
      }
    });
    this.subsArray.push(subs);
  }

    ngOnDestroy(): void {
      this.subsArray.forEach(s => s.unsubscribe());
    }
}
