import { Component } from '@angular/core';
import { ToastrService } from 'ngx-toastr';
import { FuturesOrderbookService } from 'src/app/@core/services/futures-services/futures-orderbook.service';

@Component({
  selector: 'tl-futures-history-card',
  templateUrl: '../../../spot-page/spot-trading-grid/spot-history-card/shared-history-card.component.html',
  styleUrls: ['../../../spot-page/spot-trading-grid/spot-history-card/shared-history-card.component.scss'],
})
export class FuturesHistoryCardComponent {
    displayedColumns: string[] = ['price', 'amount', 'total', 'txid'];
    
    constructor(
        private futuresOrderbookService: FuturesOrderbookService,
        private toastrService: ToastrService,
    ) { }

    get tradeHistory() {
        return [];
        return this.futuresOrderbookService.tradeHistory   
            .map(trade => {
                const { txid } = trade;
                const { amount, price } = trade.props
                return { price, txid, amount, total: parseFloat((amount * price).toFixed(6)) };
            }).splice(0, 10);
    }

    copy(text: string) {
        navigator.clipboard.writeText(text);
        this.toastrService.info(`Transaction Id Copied to clipboard: ${text}`, 'Copied')
    }
}
