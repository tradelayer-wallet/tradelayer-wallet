import { Component, OnInit } from '@angular/core';
import { TxsService } from 'src/app/@core/services/txs.service';

@Component({
  selector: 'tl-pending-txs',
  templateUrl: './pending-txs.component.html',
  styleUrls: ['./pending-txs.component.scss']
})

export class PendingTxsComponent implements OnInit {
    displayedColumns: string[] = ['id', 'status', 'txid'];
    constructor(
      private txsService: TxsService,
    ) {}

    get pendingTxs() {
      return this.txsService.pendingTxs;
    }
  
    ngOnInit() {}
}
