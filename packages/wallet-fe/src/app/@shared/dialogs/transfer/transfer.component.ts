import { Component, Inject } from '@angular/core';
import { MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { ToastrService } from 'ngx-toastr';
import { BalanceService } from 'src/app/@core/services/balance.service';
import { LoadingService } from 'src/app/@core/services/loading.service';
import { IToken } from 'src/app/@core/services/spot-services/spot-markets.service';
import { ENCODER } from 'src/app/utils/payloads/payloads/encoder';


@Component({
  selector: 'transfer-dialog',
  templateUrl: './transfer.component.html',
  styleUrls: ['./transfer.component.scss'],
})
export class TransferDialog {
  private _selectedToken: IToken = this.data.firstToken;

  private _isFromAvialable = true;
  amount: number = Math.floor(this.getMax / 2);

  constructor(
    @Inject(MAT_DIALOG_DATA)
    private data: {
      address: string;
      firstToken: IToken;
      secondToken: IToken;
    },
    public dialogRef: MatDialogRef<TransferDialog>,
    private toastrService: ToastrService,
    private loadingService: LoadingService,
    private balanceService: BalanceService
  ) {}

  get selectedToken() {
    return this._selectedToken;
  }

  set selectedToken(value: IToken) {
    this._selectedToken = value;
    if (this.amount > this.getMax) {
      this.amount = this.getMax;
    }
  }

  get isFromAvialable() {
    return this._isFromAvialable;
  }

  set isFromAvialable(value: boolean) {
    this._isFromAvialable = value;
    if (this.amount > this.getMax) {
      this.amount = this.getMax;
    }
  }

  get buttonDisabled() {
    return this.amount <= 0 || this.amount > this.getMax;
  }

  get address() {
    return this.data?.address;
  }

  get firstToken() {
    return this.data.firstToken;
  }

  get secondToken() {
    return this.data.secondToken;
  }

  get getMax() {
    const propId = this.selectedToken.propertyId;

    const tokenBalance = this.balanceService
      .getTokensBalancesByAddress(this.address)
      ?.find((t: any) => t.propertyid === propId);

    if (!tokenBalance) return 0;
    return this.isFromAvialable ? tokenBalance.available : tokenBalance.margin;
  }

  close() {
    this.dialogRef.close();
  }

  get percentFromvalue() {
    return Math.floor((this.amount / this.getMax) * 100);
  }

  changeSlider(percent: number) {
    this.amount = Math.floor(this.getMax * (percent / 100));
  }

  fillWithMax() {
    this.amount = this.getMax;
  }

  async transfer() {
    try {
      this.loadingService.isLoading = true;
      const payload = ENCODER.encodeCommit({
                amount: this.amount,
                propertyId: this.selectedToken.propertyId,
                channelAddress: this.address,
            });

      this.toastrService.success(`Transfer Test!`, 'Success');
    } catch (error: any) {
      this.toastrService.error(error.message || `Error with Withdraw`, 'Error');
    } finally {
      this.loadingService.isLoading = false;
      this.clearForm();
    }
  }

  private clearForm() {}

  copyAddress() {
    navigator.clipboard.writeText(this.address);
    this.toastrService.info('Address Copied to clipboard', 'Copied');
  }
}
