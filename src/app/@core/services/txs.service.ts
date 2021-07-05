import { Injectable } from "@angular/core";
import { ToastrService } from "ngx-toastr";
import { RpcService } from "./rpc.service";
import { SocketService } from "./socket.service";

export enum TXSTATUS {
    PENDING = 'PENDING',
    SUCCESS = 'SUCCESS',
    FAILED = 'FAILD',
}

export interface IPedningTXS {
    txid: string;
    status: TXSTATUS;
    fee: number;
}

@Injectable({
    providedIn: 'root',
})

export class TxsService {
    private _pendingTxs: IPedningTXS[] = []
    constructor(
        private socketService: SocketService,
        private rpcService: RpcService,
        private toasterService: ToastrService,
    ) {
        this.checkPendingTxs();
    }

    get pendingTxs() {
        return this._pendingTxs;
    }

    set pendingTxs(value: IPedningTXS[]) {
        this._pendingTxs = value;
    }

    addTxToPending(txid: string, fee: number) {
        const txObj = { txid, status: TXSTATUS.PENDING, fee };
        this._pendingTxs = [...this.pendingTxs, txObj];
    }

    removeFromPendingTxs(txid: string) {
        const obj = this.pendingTxs.find(e => e.txid === txid);
        this.pendingTxs = this.pendingTxs.filter(tx => tx !== obj);
    }

    private checkPendingTxs() {
        this.socketService.socket.on('newBlock', () => {
            if (!this.pendingTxs?.length) return
            this.pendingTxs
                .filter(tx => tx.status === TXSTATUS.PENDING)
                .forEach(async txs => {
                    const { txid } = txs;
                    const res = await this.rpcService.rpc('tl_gettransaction', [txid]);
                    if (res.error || !res.data) return;
                    if (res.data.confirmations > 0) {
                        const isValid = res.data.valid;
                        this.pendingToReady(txid, isValid);
                    }
                });
        })
    }

    private pendingToReady(txid: string, isValid: boolean) {
        const obj = this.pendingTxs.find(e => e.txid === txid);
        if (obj) obj.status = isValid ? TXSTATUS.SUCCESS : TXSTATUS.FAILED;

        isValid
            ? this.toasterService.success(`Transaction: ${txid} is Valid`, 'Transaction succeed')
            : this.toasterService.error(`Transaction: ${txid} is Invalid!`, 'Transaction Fail');
    }
}
