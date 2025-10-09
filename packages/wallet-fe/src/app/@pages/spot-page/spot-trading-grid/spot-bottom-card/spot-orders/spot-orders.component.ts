import { Component, OnInit, OnDestroy } from '@angular/core';
import { AuthService } from 'src/app/@core/services/auth.service';
import { obEventPrefix, SocketService } from 'src/app/@core/services/socket.service';
import { ISpotOrder } from 'src/app/@core/services/spot-services/spot-orderbook.service';
import { Subscription } from 'rxjs';
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

    get socket() {
      return this.socketService.socket;
    }

    get openedOrders() {
      return this.spotOrdersService.openedOrders;
    }

    closeOrder(uuid: string) {
      this.spotOrdersService.closeOpenedOrder(uuid);
    }

    ngOnInit() {
      this.subsribe();
    }

    private subsribe() {
      this.socket.on(
  `${obEventPrefix}::placed-orders`,
  (orders: { openedOrders: any[]; orderHistory: any[] }) => {
    const { openedOrders = [], orderHistory = [] } = orders;

    // Legacy adapters so the rest of the UI doesn't change
    const activeKey = this.authService.activeSpotKey; // may be undefined

    const toLegacyOpen = (o: any) => ({
      uuid: o.uuid,
      engine_id: o.engine_id,
      price: String(o.price),           // UI used strings previously
      amount: String(o.amount),
      side: o.side,
      marketKey: o.symbol,
      timestamp: o.timestamp,
      // legacy fields expected by filters / views:
      type: 'SPOT',
      state: 'OPEN',
      keypair: activeKey,
    });

    const toLegacyHist = (e: any) => ({
      uuid: e.uuid,
      marketKey: e.symbol,
      side: e.side,
      price: String(e.price ?? 0),
      amount: String(e.qty ?? e.quantity ?? 0),
      ts: e.ts,
      // legacy fields:
      type: 'SPOT',
      state: e.event,       // SUBMIT_ACK | RESTED | MATCH | FILLED | ...
      keypair: activeKey,
    });

    const openedLegacy = openedOrders.map(toLegacyOpen);
    const historyLegacy = orderHistory.map(toLegacyHist);

    // Keep your existing filtering intent, but now it will work on legacy shape
    this.spotOrdersService.orderHistory = historyLegacy
      .filter(q =>
        q.type === 'SPOT' &&
        (!!q.keypair?.pubkey ? q.keypair.pubkey === activeKey?.pubkey : true) &&
        q.state
      );

    this.spotOrdersService.openedOrders = openedLegacy
      .filter(q => q.type === 'SPOT');


        //this.spotOrdersService.closeOpenedOrder('test-for-update');
        this.socket.on(`${obEventPrefix}::disconnect`, () => {
          this.spotOrdersService.openedOrders = [];
        });

        const subs = this.authService.updateAddressesSubs$
          .subscribe(kp => {
            if (!this.authService.activeSpotKey || !kp.length) this.spotOrdersService.closeAllOrders();
          });
        this.subsArray.push(subs);
      }

    ngOnDestroy(): void {
      this.subsArray.forEach(s => s.unsubscribe());
    }
}
