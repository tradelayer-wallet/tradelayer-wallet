import { Component, Inject } from '@angular/core';
import { MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { ToastrService } from 'ngx-toastr';
import { ApiService } from 'src/app/@core/services/api.service';
import { AuthService } from 'src/app/@core/services/auth.service';
import { BalanceService } from 'src/app/@core/services/balance.service';
import { LoadingService } from 'src/app/@core/services/loading.service';
import { RpcService } from 'src/app/@core/services/rpc.service';
import { IBuildTxConfig, TxsService } from 'src/app/@core/services/txs.service';

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

    private async getTxOptions(
            fromAddress: string,
            toAddress: string,
            _amount: number,
            propId: number,
        ): Promise<{ data?: IBuildTxConfig, error?: any}> {
            try {
                const amount = propId === -1 ? _amount : 0;
                const txOptions: IBuildTxConfig = { fromAddress, toAddress, amount };
                if (propId !== -1) {
                    const payloadParams = [this.propId, amount];
                    const payloadRes = await this.rpcService.rpc('tl_createpayload_simplesend', payloadParams);
                    if (payloadRes.error || !payloadRes.data) throw new Error(`tl_createpayload_simplesend: ${payloadRes.error}`);
                    txOptions.payload = payloadRes.data;
                }
                return { data: txOptions };
            } catch (error: any) {
                return { error: error.message}
            }
    }

    async withdraw() {
        try {
            this.loadingService.isLoading = true;
            if (this.fromAddress === this.toAddress) throw new Error('Both addresses are the same');
            if (!this.amount || !this.fromAddress || !this.toAddress || !this.propId) throw new Error('Fill all required data');

            const txOptionsRes = await this.getTxOptions(this.fromAddress, this.toAddress, this.amount, this.propId);
            if (txOptionsRes.error || !txOptionsRes.data) throw new Error(txOptionsRes.error);

            const txRes = await this.txsService.buildTx(txOptionsRes.data);
            if (txRes.error || !txRes.data) throw new Error(txRes.error) 
            const { inputs, rawtx } = txRes.data;

            const wif = this.authService.listOfallAddresses
                .find(kp => kp.address === this.fromAddress)?.wif;
            if (!wif) throw new Error("Private Key Not found");

            const signResult = await this.txsService.signTx({ rawtx, wif, inputs });
            if (signResult.error || !signResult.data) throw new Error(signResult.error);
            if (!signResult.data.isValid) throw new Error("Error with Transaction Signing");

            const sendRes = await this.txsService.sendTx(signResult.data.signedHex);
            if (sendRes.error || !sendRes.data) throw new Error(sendRes.error);
            this.toastrService.success(sendRes.data, 'Successful send');
            this.clearForm();
        } catch (error: any) {
            this.toastrService.error(error.message || `Error with Withdraw`, 'Error');
        } finally {
            this.loadingService.isLoading = false;
        }
    }

    private clearForm() {
        this.toAddress = '';
        this.amount = null
    }
}
