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
    private subscription: Subscription;
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

     private subscribe() {

     this.subscription = this.socketService.events$.subscribe((data) => {
        console.log('checking data in subscribe futures orders '+JSON.stringify(data))
       
      if (!data || !data.event) return;

      switch (data.event) {
        case `${obEventPrefix}::placed-orders`:
          const { openedOrders, orderHistory } = data.data;
           this.futuresOrdersService.orderHistory = orderHistory
             .filter((q: IFuturesOrder) => q.type === "FUTURES" && q.keypair.pubkey === this.authService.activeFuturesKey?.pubkey && q.state);
           this.futuresOrdersService.openedOrders = openedOrders.filter((q: IFuturesOrder)=> q.type === "FUTURES");
          break;

        case `${obEventPrefix}::disconnect`:
          this.futuresOrdersService.openedOrders = [];
          break;

        default:
          
          break;
      }

       const subs = this.authService.updateAddressesSubs$
         .subscribe(kp => {1
           if (!this.authService.activeFuturesKey || !kp.length) this.futuresOrdersService.closeAllOrders();
         });
       this.subsArray.push(subs);
     })
    }

    ngOnDestroy(): void {
      this.subsArray.forEach(s => s.unsubscribe());
    }
}
