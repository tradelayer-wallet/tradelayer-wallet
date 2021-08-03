import { Component, OnInit } from '@angular/core';
import { ToastrService } from 'ngx-toastr';
import { TxsService } from 'src/app/@core/services/spot-services/txs.service';

@Component({
  selector: 'tl-pending-txs',
  templateUrl: './pending-txs.component.html',
  styleUrls: ['./pending-txs.component.scss']
})

export class PendingTxsComponent implements OnInit {
    displayedColumns: string[] = ['id', 'status', 'txid', 'fee'];
    constructor(
      private txsService: TxsService,
      private toastrService: ToastrService,
    ) {}

    get pendingTxs() {
      return this.txsService.pendingTxs;
    }
  
    ngOnInit() {}

    copyToClipboard(text: string) {
      navigator.clipboard.writeText(text);
      this.toastrService.info('TX id Copied to clipboard', 'Copied')
    }
}
