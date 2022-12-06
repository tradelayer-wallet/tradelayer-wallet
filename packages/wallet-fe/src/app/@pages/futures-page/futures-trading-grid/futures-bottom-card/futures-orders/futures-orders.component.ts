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

    displayedColumns: string[] = ['market', 'amount', 'price', 'isBuy', 'close'];

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
      this.subsribe();
    }

    private subsribe() {
      this.socket.on(`${obEventPrefix}::placed-orders`, (orders: { openedOrders: IFuturesOrder[], orderHistory: IFuturesOrder[] }) => {
        const { openedOrders, orderHistory } = orders;

        this.futuresOrdersService.orderHistory = orderHistory
          .filter(q => q.type === "FUTURES" && q.keypair.pubkey === this.authService.activeFuturesKey?.pubkey && q.state);
        this.futuresOrdersService.openedOrders = openedOrders.filter(q => q.type === "FUTURES");
      });
      this.futuresOrdersService.closeOpenedOrder('test-for-update');
      this.socket.on(`${obEventPrefix}::disconnect`, () => {
        this.futuresOrdersService.openedOrders = [];
      });

      const subs = this.authService.updateAddressesSubs$
        .subscribe(kp => {
          if (!this.authService.activeFuturesKey || !kp.length) this.futuresOrdersService.closeAllOrders();
        });
      this.subsArray.push(subs);
    }

    ngOnDestroy(): void {
      this.subsArray.forEach(s => s.unsubscribe());
    }
}
