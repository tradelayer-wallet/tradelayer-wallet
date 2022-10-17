import { Component, OnInit } from '@angular/core';
import { ToastrService } from 'ngx-toastr';
import { SpotOrderbookService } from 'src/app/@core/services/spot-services/spot-orderbook.service';

@Component({
  selector: 'tl-spot-history-card',
  templateUrl: './shared-history-card.component.html',
  styleUrls: ['./shared-history-card.component.scss'],
})
export class SpotHistoryCardComponent {
    displayedColumns: string[] = ['price', 'amount', 'total', 'txid'];
    
    constructor(
        private spotOrderbookService: SpotOrderbookService,
        private toastrService: ToastrService,
    ) { }

    get tradeHistory() {
        return this.spotOrderbookService.tradeHistory   
            .map(trade => {
                const { txid } = trade;
                const { amountForSale, amountDesired } = trade.props;
                const price = parseFloat((amountForSale / amountDesired).toFixed(6)) || 1;
                return { price, txid, amount: amountDesired, total: amountForSale };
            }).splice(0, 10);
    }

    copy(text: string) {
        navigator.clipboard.writeText(text);
        this.toastrService.info(`Transaction Id Copied to clipboard: ${text}`, 'Copied')
    }
}
