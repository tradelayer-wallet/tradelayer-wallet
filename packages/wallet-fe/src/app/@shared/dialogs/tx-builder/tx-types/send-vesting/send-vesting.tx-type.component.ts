import { Component, Inject, Input, Output, EventEmitter } from '@angular/core';
import { ToastrService } from 'ngx-toastr';
import { BuilderService } from 'src/app/@core/services/builder.service';
import { LoadingService } from 'src/app/@core/services/loading.service';
import { RpcService } from 'src/app/@core/services/rpc.service';

@Component({
  selector: 'tx-type-send-vesting',
  templateUrl: './send-vesting.tx-type.component.html',
  styleUrls: ['./send-vesting.tx-type.component.scss']
})
export class SendVestingTxTypeComponent {
    @Input('sender') sender: string = '';
    @Output('rawTxEvent') rawTxEvent = new EventEmitter<string>();

    _toAddress: string = '';
    amount: number = 0;

    isAddressValid: boolean | null | 'PENDING' = null;

  
    constructor (
      private rpcService: RpcService,
      private toastrService: ToastrService,
      private builderSrvice: BuilderService,
      private loadingService: LoadingService,
    ) { }

    get toAddress() {
      return this._toAddress
    }

    set toAddress(value: string) {
        this._toAddress = value;
        this.isAddressValid = null;
    }

    get buildDisabled() {
      return !this.sender || !this.toAddress || !this.amount || this.isAddressValid === 'PENDING' || this.isAddressValid === false;
    }

    async validateAddress(address: string) {
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
  
    async build() {
      this.loadingService.isLoading = true;
      const tradeData = {
        fromAddress: this.sender,
        toAddress: this.toAddress,
        amount: this.amount,
        txType: 'SEND_VESTING',
      };

      const result = await this.builderSrvice.build(tradeData).toPromise();
      const { error, data } = result;

      if (error || !data ) {
        this.toastrService.error(error || 'Undefined Error!', 'Error');
        this.loadingService.isLoading = false;
        return;
      }

      this.rawTxEvent.emit(data);
      this.loadingService.isLoading = false;
    }
}
