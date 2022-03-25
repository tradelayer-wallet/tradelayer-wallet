import { Component } from '@angular/core';
import { ToastrService } from 'ngx-toastr';
import { FuturesOrderbookService } from 'src/app/@core/services/futures-services/futures-orederbook.service';

@Component({
  selector: 'tl-futures-history-card',
  templateUrl: '../../../shared/trading-grid/history/shared-history-card.component.html',
  styleUrls: ['../../../shared/trading-grid/history/shared-history-card.component.scss'],
})
export class FuturesHistoryCardComponent {
    displayedColumns: string[] = ['price', 'amount', 'total', 'txid'];
    
    constructor(
        private futuresOrderbookService: FuturesOrderbookService,
        private toastrService: ToastrService,
    ) { }

    get tradeHistory() {
        // return this.spotOrderbookService.tradeHistory   
        //     .map(trade => {
        //         const {amountForSale, amountDesired, txid } = trade;
        //         const price = parseFloat((amountForSale / amountDesired).toFixed(4));
        //         return { price, txid, amount: parseFloat(amountDesired) };
        //     }).splice(0, 10);
        return [];
    }

    copy(text: string) {
        navigator.clipboard.writeText(text);
        this.toastrService.info('Transaction Id Copied to clipboard', 'Copied')
    }
}
