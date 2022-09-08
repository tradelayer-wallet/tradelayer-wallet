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

    displayedColumns: string[] = ['market', 'amount', 'price', 'isBuy', 'close'];

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
      this.socket.on(`${obEventPrefix}::placed-orders`, (openedOrders: ISpotOrder[]) => {
        this.spotOrdersService.openedOrders = openedOrders;
      });

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
