import { Component } from '@angular/core';
import { ToastrService } from 'ngx-toastr';
import { SpotMarketsService } from 'src/app/@core/services/spot-services/spot-markets.service';
import { SpotOrderbookService } from 'src/app/@core/services/spot-services/spot-orderbook.service';

@Component({
  selector: 'tl-spot-related-history',
  templateUrl: './spot-related-history.component.html',
  styleUrls: ['./spot-related-history.component.scss']
})

export class SpotRelatedHistoryComponent {
  displayedColumns: string[] = [ 'side', 'buyer', 'seller', 'amount', 'price', 'total', 'txid'];

  constructor(
    private spotOrderbookService: SpotOrderbookService,
    private toastrService: ToastrService,
    private spotMarketService: SpotMarketsService,
  ) {}

  get relayedHistory() {
    return this.spotOrderbookService.relatedHistoryTrades;
  }

  get selectedMarket() {
    return this.spotMarketService.selectedMarket;
  }

  copy(text: string) {
    navigator.clipboard.writeText(text);
    this.toastrService.info(`Transaction Id Copied to clipboard: ${text}`, 'Copied')
  }
}
