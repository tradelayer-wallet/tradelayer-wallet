import { Component, OnInit } from '@angular/core';
import { ToastrService } from 'ngx-toastr';
import { TxsService } from 'src/app/@core/services/spot-services/txs.service';

@Component({
  selector: 'tl-spot-pending-txs',
  templateUrl: './spot-pending-txs.component.html',
  styleUrls: ['./spot-pending-txs.component.scss']
})

export class SpotPendingTxsComponent implements OnInit {
    displayedColumns: string[] = [ 'txid', 'status', 'fee'];
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
