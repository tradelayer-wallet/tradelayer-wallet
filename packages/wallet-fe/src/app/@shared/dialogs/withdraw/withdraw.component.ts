import { Component, Inject } from '@angular/core';
import { MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { ToastrService } from 'ngx-toastr';
import { ApiService } from 'src/app/@core/services/api.service';
import { AuthService } from 'src/app/@core/services/auth.service';
import { BalanceService } from 'src/app/@core/services/balance.service';
import { TxsService } from 'src/app/@core/services/txs.service';

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
        private toastrService: ToastrService,
        private apiService: ApiService,
        private txsService: TxsService,
        private authService: AuthService,
    ) { }

    get propId() {
        return this.data?.propId;
    }

    get toAddress() {
        return this._toAddress
    }

    set toAddress(value: string) {
        this._toAddress = value;
        this.isAddressValid = null;
    }

    get fromAddress() {
        return this.data?.address;
    }

    get maxWithdrawAmount() {
        if (this.propId === -1) {
            const balanceObj = this.balanceService.getCoinBalancesByAddress(this.fromAddress);
            return balanceObj.confirmed;
        } else {
            const balanceObj = this.balanceService.getTokensBalancesByAddress(this.fromAddress)
                .find((o: any) => o.propertyid === this.propId);
            if (!balanceObj) return 0;
            return balanceObj.balance;
        }
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

    get tokenName() {
        return this.propId === -1
            ? 'LTC'
            : this.balanceService.getTokensBalancesByAddress(this.fromAddress)
                .find((e: any) => e.propertyid === this.propId)?.name;
    }

    get tlApi() {
        return this.apiService.tlApi;
    }

    fillAmountInput() {
        this.amount = this.maxWithdrawAmount;
    }

    close() {
        this.dialogRef.close();
    }

    async validateAddress(address: string | null) {
        try {
            this.isAddressValid = 'PENDING';
            if (!address) throw new Error("Address not defined");
            const vaRes = await this.tlApi.validateAddress(address).toPromise();
            const { error, data } = vaRes;
            if (error || !data) throw new Error(error || 'Error with validateing the address');
            await new Promise((res) => setTimeout(() => res(true), 500));
            const { isvalid } = data;
            this.isAddressValid = isvalid;
        } catch (error: any) {
            this.toastrService.error(error.message, 'Validation Error');
            this.isAddressValid = null;
        }
    }

    async withdraw() {
        try {
            if (this.fromAddress === this.toAddress) throw new Error('Both addresses are the same');
            if (!this.amount || !this.fromAddress || !this.toAddress || !this.propId) throw new Error('Fill all required data');
            const txRes = await this.txsService.buildTx({
                fromAddress: this.fromAddress,
                toAddress: this.toAddress,
                amount: this.amount,
            });
            if (txRes.error || !txRes.data) {
                this.toastrService.error(txRes.error, 'TX Builder');
            } else {
                const { inputs, rawtx } = txRes.data;
                console.log(inputs, rawtx);
                const wif = this.authService.listOfallAddresses
                    .find(kp => kp.address === this.fromAddress)?.wif;
                if (!wif) throw new Error("Private Key Not found");
                const signResult = await this.txsService.signTx({ rawtx, wif, inputs });
                console.log({signResult});
            }
            this.clearForm();
        } catch (error: any) {
            this.toastrService.error(error.message || `Error with Withdraw`, 'Error');
        }
    }

    private clearForm() {
        this.toAddress = '';
        this.amount = null
    }
}
