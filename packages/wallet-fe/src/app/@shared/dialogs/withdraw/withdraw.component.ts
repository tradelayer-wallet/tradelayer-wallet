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
        const available = this.balanceService.getBalancesByAddress(this.fromAddress)?.['bal_999']?.available;
        const max = parseFloat((available - 0.001).toFixed(6))
        return max;
    }

    get buttonDisabled() {
        return (
            !this.amount ||
            !this.toAddress ||
            !this.fromAddress ||
            this.isAddressValid === false ||
            this.isAddressValid === 'PENDING'
            || typeof this.amount !== 'number'
            || this.amount < 0.001
            || this.amount > this.maxWithdrawAmount
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

    async withdraw() {
        if (!this.amount || !this.fromAddress || !this.toAddress) return;
        const withdrawOptions = {
            fromAddress: this.fromAddress,
            toAddress: this.toAddress,
            amount: this.amount,
        };
        this.clearForm();
        const res = await this.balanceService.withdraw(withdrawOptions);
        if (res.error || !res.data) {
            this.toastrService.error(res.error || `Error with Withdraw`, 'Error');
        } else {
            this.toastrService.success(res.data, 'Successfull Withdraw');
        }
    }

    private clearForm() {
        this.toAddress = '';
        this.amount = null
    }
}
