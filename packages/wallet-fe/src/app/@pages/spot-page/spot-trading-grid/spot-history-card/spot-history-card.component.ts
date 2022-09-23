import { Component, OnInit } from '@angular/core';
import { ToastrService } from 'ngx-toastr';
import { SpotOrderbookService } from 'src/app/@core/services/spot-services/spot-orderbook.service';

@Component({
  selector: 'tl-spot-history-card',
  templateUrl: './shared-history-card.component.html',
  styleUrls: ['./shared-history-card.component.scss'],
})
export class SportHistoryCardComponent {
    displayedColumns: string[] = ['price', 'amount', 'total', 'txid'];
    
    constructor(
        private spotOrderbookService: SpotOrderbookService,
        private toastrService: ToastrService,
    ) { }

    get tradeHistory() {
        return this.spotOrderbookService.tradeHistory   
            .map(trade => {
                const {amountForSale, amountDesired, txid, price } = trade;
                return { price, txid, amount: amountDesired, total: amountForSale };
            }).splice(0, 10);
    }

    copy(text: string) {
        navigator.clipboard.writeText(text);
        this.toastrService.info(`Transaction Id Copied to clipboard: ${text}`, 'Copied')
    }
}
