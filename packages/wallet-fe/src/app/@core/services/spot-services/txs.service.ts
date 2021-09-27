import { Injectable } from "@angular/core";
import { ToastrService } from "ngx-toastr";
import { RpcService } from "../rpc.service";
import { SocketService } from "../socket.service";

export enum TXSTATUS {
    PENDING = 'PENDING',
    SUCCESS = 'SUCCESS',
    FAILED = 'FAILD',
}

export interface IPedningTXS {
    txid: string;
    status: TXSTATUS;
    fee: number;
    propId: number,
    amount: number,
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

    async addTxToPending(txid: string, tradeData: { propId: number, amount: string }) {
        const { propId, amount } = tradeData;
        const fee = await this.getTxFee(txid)
        const txObj = { txid, status: TXSTATUS.PENDING, propId, amount: parseFloat(amount), fee };
        this.pendingTxs = [txObj, ...this.pendingTxs];
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

    async getTxFee(txid: string) {
        const res = await this.rpcService.rpc('tl_gettransaction', [txid]);
        if (res.error || !res.data) return 0;
        return res.data.fee;
    }
}
