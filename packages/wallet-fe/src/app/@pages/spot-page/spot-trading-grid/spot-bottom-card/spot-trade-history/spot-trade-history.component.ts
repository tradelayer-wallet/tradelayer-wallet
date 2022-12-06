import { Component } from '@angular/core';
import { ToastrService } from 'ngx-toastr';
import { SpotMarketsService } from 'src/app/@core/services/spot-services/spot-markets.service';
import { ISpotHistoryTrade, SpotOrderbookService } from 'src/app/@core/services/spot-services/spot-orderbook.service';

@Component({
  selector: 'tl-spot-trade-history',
  templateUrl: './spot-trade-history.component.html',
  styleUrls: ['./spot-trade-history.component.scss']
})

export class SpotTradeHistoryComponent {
  displayedColumns: string[] = [ 'side', 'buyer', 'seller', 'amount', 'price', 'total', 'txid'];

  constructor(
    private spotOrderbookService: SpotOrderbookService,
    private toastrService: ToastrService,
    private spotMarketService: SpotMarketsService,
  ) {}

  get relayedHistory(): ISpotHistoryTrade[] {
    return this.spotOrderbookService.relatedHistoryTrades;
  }

  get selectedMarket() {
    return this.spotMarketService.selectedMarket;
  }

  copy(text: string) {
    navigator.clipboard.writeText(text);
    this.toastrService.info(`Transaction Id Copied to clipboard: ${text}`, 'Copied')
  }

  getPrice(element: ISpotHistoryTrade) {
    const { amountForSale, amountDesired } = element.props;
    return parseFloat((amountForSale / amountDesired).toFixed(6)) || 1;
  }
}
