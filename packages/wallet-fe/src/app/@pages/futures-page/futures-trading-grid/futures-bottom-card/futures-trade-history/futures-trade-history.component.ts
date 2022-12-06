import { Component } from '@angular/core';
import { ToastrService } from 'ngx-toastr';
import { FuturesMarketService } from 'src/app/@core/services/futures-services/futures-markets.service';
import { FuturesOrderbookService } from 'src/app/@core/services/futures-services/futures-orderbook.service';

@Component({
  selector: 'tl-futures-trade-history',
  templateUrl: '../../../../spot-page/spot-trading-grid/spot-bottom-card/spot-trade-history/spot-trade-history.component.html',
  styleUrls: ['../../../../spot-page/spot-trading-grid/spot-bottom-card/spot-trade-history/spot-trade-history.component.scss']
})

export class FuturesTradeHistoryComponent {
  displayedColumns: string[] = [ 'side', 'buyer', 'seller', 'amount', 'price', 'total', 'txid'];

  constructor(
    private futuresOrderbookService: FuturesOrderbookService,
    private toastrService: ToastrService,
    private futuresMarketService: FuturesMarketService,
  ) {}

  get relayedHistory() {
    return [];
    return this.futuresOrderbookService.relatedHistoryTrades;
  }

  get selectedMarket() {
    return this.futuresMarketService.selectedMarket;
  }

  copy(text: string) {
    navigator.clipboard.writeText(text);
    this.toastrService.info(`Transaction Id Copied to clipboard: ${text}`, 'Copied')
  }
}
