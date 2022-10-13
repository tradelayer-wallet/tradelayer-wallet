import { Component } from '@angular/core';
import { ToastrService } from 'ngx-toastr';

@Component({
  selector: 'tl-futures-history-card',
  templateUrl: '../../../spot-page/spot-trading-grid/spot-history-card/shared-history-card.component.html',
  styleUrls: ['../../../spot-page/spot-trading-grid/spot-history-card/shared-history-card.component.scss'],
})
export class FuturesHistoryCardComponent {
    displayedColumns: string[] = ['price', 'amount', 'total', 'txid'];
    
    constructor(
        // private spotOrderbookService: SpotOrderbookService,
        private toastrService: ToastrService,
    ) { }

    get tradeHistory() {
        return []
        // return this.spotOrderbookService.tradeHistory   
        //     .map(trade => {
        //         const {amountForSale, amountDesired, txid, price } = trade;
        //         return { price, txid, amount: amountDesired, total: amountForSale };
        //     }).splice(0, 10);
    }

    copy(text: string) {
        navigator.clipboard.writeText(text);
        this.toastrService.info(`Transaction Id Copied to clipboard: ${text}`, 'Copied')
    }
}
