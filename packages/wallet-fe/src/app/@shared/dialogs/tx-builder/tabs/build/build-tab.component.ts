import { Component, EventEmitter, Input, Output } from '@angular/core';
import { ToastrService } from 'ngx-toastr';
import { RpcService } from 'src/app/@core/services/rpc.service';

const TX_TYPES = {
  SEND_VESTING: "SEND_VESTING",
  SEND_LTC: "SEND_LTC",
};

@Component({
  selector: 'tx-builder-build-tab',
  templateUrl: './build-tab.component.html',
  styleUrls: ['./build-tab.component.scss']
})

export class TxBuilderBuildTabComponent {
  @Output('loading') loadingEmmiter: EventEmitter<boolean> = new EventEmitter();
  @Input('hexOutput') hexOutput: string = '';

  private _loading: boolean = false;

  private _selectedTxType: string = '';
  private _fromAddress: string = '';
  isAddressValid: boolean | null | 'PENDING' = null;

  constructor(
    private rpcService: RpcService,
    private toastrService: ToastrService,
  ) { }
  
  get loading() {
    return this._loading;
  }

  set loading(value: boolean) {
    this.loadingEmmiter.emit(value);
    this._loading = value;
  }

  get txTypes() {
    return TX_TYPES;
  }
  
  get selectedTxType() {
    return this._selectedTxType;
  }

  set selectedTxType(txType: string) {
    this._selectedTxType = txType;
  }

  get fromAddress() {
    return this._fromAddress;
  }

  set fromAddress(address: string) {
    this.isAddressValid = null;
    this._fromAddress = address;
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
}
