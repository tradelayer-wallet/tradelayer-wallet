import { Component, Inject } from '@angular/core';
import { MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { ToastrService } from 'ngx-toastr';
import { BalanceService } from 'src/app/@core/services/balance.service';
import { RpcService } from 'src/app/@core/services/rpc.service';

@Component({
  selector: 'withdraw-dialog',
  templateUrl: './withdraw.component.html',
  styleUrls: ['./withdraw.component.scss']
})
export class WithdrawDialog {
    private _toAddress: string = '';
    amount: number | null = null;
    isAddressValid: boolean | null | 'PENDING' = null;

    constructor(
        @Inject(MAT_DIALOG_DATA) private data: any,
        public dialogRef: MatDialogRef<WithdrawDialog>,
        private balanceService: BalanceService,
        private rpcService: RpcService,
        private toastrService: ToastrService,
    ) { }

    get toAddress() {
        return this._toAddress
    }

    set toAddress(value: string) {
        this._toAddress = value;
        this.isAddressValid = null;
    }

    get fromAddress() {
        return this.data;
    }

    get maxWithdrawAmount() {
        return this.balanceService.getBalancesByAddress(this.fromAddress)?.['bal_999']?.available;
    }

    get buttonDisabled() {
        return (
            !this.amount ||
            !this.toAddress ||
            !this.fromAddress ||
            this.isAddressValid === false ||
            this.isAddressValid === 'PENDING'
        );
    }

    close() {
        this.dialogRef.close();
    }

    fillAmountInput() {
        this.amount = this.maxWithdrawAmount;
    }

    async validateAddress(address: string | null) {
        this.isAddressValid = 'PENDING';
        const vaRes = await this.rpcService.rpc('validateaddress', [address]);
        const { error, data } = vaRes;
        if (error || !data) {
            this.toastrService.error(error.message || 'Error with validateing the address', 'Validation Error');
            this.isAddressValid = null;
            return
        }
        await new Promise((res) => setTimeout(() => res(true), 3000));
        const { isvalid } = data;
        this.isAddressValid = isvalid;
    }

    withdraw() {
        if (!this.amount || !this.fromAddress || !this.toAddress) return;
        this.balanceService.withdraw({
            fromAddress: this.fromAddress,
            toAddress: this.toAddress,
            amount: this.amount,
        });
    }
}
