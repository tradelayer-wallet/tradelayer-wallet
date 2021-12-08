import { Component, Inject, Input, Output, EventEmitter } from '@angular/core';
import { ToastrService } from 'ngx-toastr';
import { BuilderService } from 'src/app/@core/services/builder.service';
import { RpcService } from 'src/app/@core/services/rpc.service';
import { TX_TYPES } from '../../tabs/build/build-tab.component';

@Component({
  selector: 'tx-type-send-activation',
  templateUrl: './send-activation.tx-type.component.html',
  styleUrls: ['./send-activation.tx-type.component.scss']
})
export class SendActivationTxTypeComponent {
    @Output('loading') loadingEmmiter: EventEmitter<boolean> = new EventEmitter();
    @Output('hexOutput') hexOutputEmmiter: EventEmitter<string> = new EventEmitter();

    @Input('sender') sender: string = '';

    private _loading: boolean = false;
    private _toAddress: string = '';

    featureId: number = NaN;
    block: number = NaN;
    minclientversion: number = NaN;

    isAddressValid: boolean | null | 'PENDING' = null;

    constructor (
      private rpcService: RpcService,
      private toastrService: ToastrService,
      private builderService: BuilderService,
    ) { }

    get toAddress() {
      return this._toAddress;
    }

    set toAddress(value: string) {
        this._toAddress = value;
        this.isAddressValid = null;
    }

    get buttonDisabled() {
      return !this.sender ||
        !this.toAddress ||
        !this.featureId ||
        !this.block ||
        !this.minclientversion ||
        this.isAddressValid === 'PENDING' ||
        this.isAddressValid === false;
    }
      
    get loading() {
      return this._loading;
    }

    set loading(value: boolean) {
      this.loadingEmmiter.emit(value);
      this._loading = value;
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
      this.loading = true;
      this.hexOutputEmmiter.emit('');
      const tradeData = {
        fromAddress: this.sender,
        toAddress: this.toAddress,
        featureid: this.featureId,
        block: this.block,
        minclientversion: this.minclientversion,
        txType: TX_TYPES.SEND_ACTIVATION,
      };
      const result = await this.builderService.build(tradeData);
      result.error || !result.data
        ? this.toastrService.error(result.error || 'Undefined Error!', 'Error')
        : this.hexOutputEmmiter.emit(result.data);
      this.loading = false;
    }
}
