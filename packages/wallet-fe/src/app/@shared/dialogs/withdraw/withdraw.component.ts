import { Component, Inject } from '@angular/core';
import { MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { ToastrService } from 'ngx-toastr';
import { ApiService } from 'src/app/@core/services/api.service';
import { AuthService } from 'src/app/@core/services/auth.service';
import { BalanceService } from 'src/app/@core/services/balance.service';
import { LoadingService } from 'src/app/@core/services/loading.service';
import { RpcService } from 'src/app/@core/services/rpc.service';
import { IBuildTxConfig, TxsService } from 'src/app/@core/services/txs.service';
import { ENCODER } from 'src/app/utils/payloads/encoder';

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
        private loadingService: LoadingService,
        private rpcService: RpcService,
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
        console.log('inside send '+this.propId)
        if (this.propId === -1) {
            const balanceObj = this.balanceService.getCoinBalancesByAddress(this.fromAddress);
            return balanceObj.confirmed;
        } else {
            const balanceObj = this.balanceService.getTokensBalancesByAddress(this.fromAddress)
                .find((o: any) => o.propertyid === this.propId);
            if (!balanceObj) return 0;
            return balanceObj.available;
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
            || this.amount < 0.0001
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
            // this.isAddressValid = 'PENDING';
            // if (!address) throw new Error("Address not defined");
            // const vaRes = await this.tlApi.validateAddress(address).toPromise();
            // const { error, data } = vaRes;
            // if (error || !data) throw new Error(error || 'Error with validateing the address');
            // await new Promise((res) => setTimeout(() => res(true), 500));
            // const { isvalid } = data;
            // this.isAddressValid = isvalid;
        } catch (error: any) {
            this.toastrService.error(error.message, 'Validation Error');
            this.isAddressValid = null;
        }
    }

    private async getTxOptions(
            fromAddress: string,
            toAddress: string,
            amount: number,
            propId: number,
        ): Promise<{ data?: IBuildTxConfig, error?: any}> {
            try {
                const fromKeyPair = { address: fromAddress };
                const toKeyPair = { address: toAddress };
                const txOptions: IBuildTxConfig = { fromKeyPair, toKeyPair };
                if (propId !== -1) {
                    // const payloadParams = [this.propId, (amount).toString()];
                    const payloadRes = ENCODER.encodeSend({ sendAll: false, address: toAddress, propertyId: this.propId, amount: amount });
                    // const payloadRes = await this.rpcService.rpc('tl_createpayload_simplesend', payloadParams);
                    // if (payloadRes.error || !payloadRes.data) throw new Error(`tl_createpayload_simplesend: ${payloadRes.error}`);
                    txOptions.payload = payloadRes;
                } else {
                    txOptions.amount = amount
                }
                return { data: txOptions };
            } catch (error: any) {
                return { error: error.message}
            }
    }

 async withdraw() {
    const TIMEOUT_MS = 10000; // 10 seconds

    try {
        this.loadingService.isLoading = true;

        // Validate the input data
        if (this.fromAddress === this.toAddress) {
            throw new Error('Both addresses are the same');
        }
        if (!this.fromAddress || !this.toAddress || this.amount === null || this.amount === undefined || !this.propId) {
            throw new Error('Fill all required data');
        }

        // Ensure `amount` is a number before passing it
        const validatedAmount = Number(this.amount);

        // Race between the actual withdraw process and a timeout
        await Promise.race([
            this.executeWithdraw(validatedAmount), // Pass validated amount
            this.createTimeout(TIMEOUT_MS) // Timeout
        ]);

    } catch (error: any) {
        console.error('Issue in withdraw function:', error);

        const knownErrors = [
            'Both addresses are the same',
            'Fill all required data',
            'Transaction Options Error',
            'Transaction Error',
            'Transaction timed out'
        ];

        const message = knownErrors.includes(error.message)
            ? error.message
            : 'An unexpected error occurred. Please try again.';

        this.toastrService.error(message, 'Error');
    } finally {
        this.loadingService.isLoading = false;
        this.clearForm();
    }
}


private createTimeout(ms: number): Promise<void> {
    return new Promise((_, reject) => {
        setTimeout(() => {
            this.toastrService.error('Transaction is taking too long. Please try again.', 'Timeout');
            reject(new Error('Transaction timed out'));
        }, ms);
    });
}

private async executeWithdraw(amount: number) {
    const txOptionsRes = await this.getTxOptions(this.fromAddress, this.toAddress, amount, this.propId);

    if (!txOptionsRes.data) {
        throw new Error(txOptionsRes.error || 'Transaction Options Error');
    }

    const res = await this.txsService.buildSingSendTx(txOptionsRes.data);

    if (!res.data) {
        throw new Error(res.error || 'Transaction Error');
    }

    this.toastrService.success(`Withdraw TX: ${res.data}`, 'Success');
}




    private clearForm() {
        this.toAddress = '';
        this.amount = null
    }
}
