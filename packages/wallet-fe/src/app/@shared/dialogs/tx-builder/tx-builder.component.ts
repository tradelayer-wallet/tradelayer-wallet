import { Component, Inject, Input } from '@angular/core';
import { MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { AddressService, IKeyPair, IMultisigPair } from 'src/app/@core/services/address.service';
import { RpcService } from 'src/app/@core/services/rpc.service';

const TX_TYPES = {
    SEND_VESTING: "SEND_VESTING",
    SEND_LTC: "SEND_LTC",
};

@Component({
  selector: 'tx-builder-dialog',
  templateUrl: './tx-builder.component.html',
  styleUrls: ['./tx-builder.component.scss']
})

export class TxBuilderDialog {
    private _selectedTxType: string = '';
    private _selectedKeyPair: IKeyPair | IMultisigPair = this.allKeyPairs[0];
    public rawTX: string = '';

    constructor(
        @Inject(MAT_DIALOG_DATA) private data: any,
        public dialogRef: MatDialogRef<TxBuilderDialog>,
        private rpcService: RpcService,
        private addressService: AddressService,
    ) { }

    get buildDisabled() {
        return true;
    }

    get selectedKeyPair() {
        return this._selectedKeyPair;
    }

    set selectedKeyPair(keyPair: IKeyPair | IMultisigPair) {
        this._selectedKeyPair = keyPair;
    }

    get selectedTxType() {
        return this._selectedTxType;
    }

    set selectedTxType(txType: string) {
        this._selectedTxType = txType;
    }

    get txTypes() {
        return TX_TYPES;
    }

    get allKeyPairs() {
        return [...this.addressService.keyPairs, ...this.addressService.multisigPairs];
    }

    updateRawTx(rawTx: string) {
        this.rawTX = '';
        setTimeout(() => {
            console.log(rawTx);
            this.rawTX = rawTx;
        }, 5);
    }

    close() {
        this.dialogRef.close();
    }
}
