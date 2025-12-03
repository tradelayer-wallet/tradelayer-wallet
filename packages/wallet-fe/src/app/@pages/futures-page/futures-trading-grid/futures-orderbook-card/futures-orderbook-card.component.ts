import { Component, Input, ViewChild, OnInit, OnDestroy, ChangeDetectionStrategy, ChangeDetectorRef } from '@angular/core';
import { Subject } from 'rxjs';
import { takeUntil, auditTime } from 'rxjs/operators';
import { FuturesMarketService } from 'src/app/@core/services/futures-services/futures-markets.service';
import { FuturesOrderbookService } from 'src/app/@core/services/futures-services/futures-orderbook.service';
import { FuturesOrdersService } from 'src/app/@core/services/futures-services/futures-orders.service';

export interface PeriodicElement {
  price: number;
  amount: number;
}

@Component({
  selector: 'tl-futures-orderbook-card',
  templateUrl: './futures-orderbook-card.component.html',
  styleUrls: ['./orderbook-card.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class FuturesOrderbookCardComponent implements OnInit, OnDestroy {
    @ViewChild('sellOrdersContainer') sellOrdersContainer: any;
    
    // === FIX: Replace boolean with Subject for proper cleanup ===
    private destroy$ = new Subject<void>();

    buyOrderbooks$ = this.futuresOrderbookService.buyOrderbooks$;
    sellOrderbooks$ = this.futuresOrderbookService.sellOrderbooks$;
    displayedColumns: string[] = ['price', 'amount', 'total'];
    clickedRows = new Set<PeriodicElement>();

    constructor(
      private futuresOrderbookService: FuturesOrderbookService,
      private futuresOrdersService: FuturesOrdersService,
      private futuresMarketService: FuturesMarketService,
      private cd: ChangeDetectorRef
    ) {}

    ngOnInit() {
      this.futuresOrderbookService.subscribeForOrderbook();
      
      // === FIX: The service now handles throttling internally ===
      // We just need to trigger CD when it tells us to
      this.futuresOrderbookService.onUpdate = () => {
        this.cd.markForCheck();
      };
    }

    get upTrend() {
      return this.lastPrice > this.marketPrice;
    }

    get lastPrice() {
      return this.futuresOrderbookService.lastPrice;
    }

    get marketPrice() {
      return this.futuresOrderbookService.currentPrice;
    }

    get openedOrders() {
      return this.futuresOrdersService.openedOrders;
    }

    get openedBuyOrders() {
      return this.openedOrders.filter(p => {
        const isBuy = p.action === "BUY";
        const matchContract = p.props.contract_id === this.selectedMarket.contract_id;
        return isBuy && matchContract;
      });
    }

    get openedSellOrders() {
      return this.openedOrders.filter(p => {
        const isSell = p.action === "SELL";
        const matchContract = p.props.contract_id === this.selectedMarket.contract_id;
        return isSell && matchContract;
      });
    }

    get selectedMarket() {
      return this.futuresMarketService.selectedMarket;
    }

    // === NEW: trackBy functions to prevent DOM reconstruction ===
    trackByPrice(index: number, item: { price: number; amount: number }): number {
      return item.price;
    }

    scrollToBottom() {
      if (this.sellOrdersContainer?.nativeElement) {
        this.sellOrdersContainer.nativeElement.scrollTop = this.sellOrdersContainer.nativeElement.scrollHeight;
      }
    }

    ngAfterViewChecked() {
      this.scrollToBottom();
    }

    ngOnDestroy() {
      this.destroy$.next();
      this.destroy$.complete();
      this.futuresOrderbookService.endOrderbookSubscription();
      this.futuresOrderbookService.onUpdate = undefined;
    }

    fillBuySellPrice(price: number) {
      if (price) this.futuresOrderbookService.outsidePriceHandler.next(price);
    }
}
