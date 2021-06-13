import { Injectable } from "@angular/core";
import { RpcService } from "./rpc.service";
import { SocketService } from "./socket.service";

export enum TXSTATUS {
    PENDING = 'PENDING',
}

export interface IPedningTXS {
    txid: string;
    status: TXSTATUS;
}

@Injectable({
    providedIn: 'root',
})

export class TxsService {
    private _pendingTxs: IPedningTXS[] = []
    constructor(
        private socketService: SocketService,
        private rpcService: RpcService,
    ) {
        this.checkPendingTxs();
    }

    get pendingTxs() {
        return this._pendingTxs;
    }

    set pendingTxs(value: IPedningTXS[]) {
        this._pendingTxs = value;
    }

    addTxToPending(txid: string) {
        const txObj = { txid: txid, status: TXSTATUS.PENDING };
        this._pendingTxs = [...this.pendingTxs, txObj]
    }

    removeFromPendingTxs(txid: string) {
        const obj = this.pendingTxs.find(e => e.txid === txid);
        this.pendingTxs = this.pendingTxs.filter(tx => tx !== obj);
    }

    private checkPendingTxs() {
        this.socketService.socket.on('newBlock', () => {
            if (!this.pendingTxs?.length) return
            this.pendingTxs.forEach(async txs => {
                const { txid } = txs;
                const res = await this.rpcService.rpc('tl_gettransaction', [txid]);
                if (res.error || !res.data) return;
                if (res.data.confirmations > 0) {
                    this.removeFromPendingTxs(txid)
                }
            });
        })
    }
}
