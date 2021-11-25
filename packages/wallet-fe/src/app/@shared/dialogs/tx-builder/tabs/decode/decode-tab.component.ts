import { Component, EventEmitter, Output } from '@angular/core';
import { ToastrService } from 'ngx-toastr';
import { RpcService } from 'src/app/@core/services/rpc.service';

@Component({
  selector: 'tx-builder-decode-tab',
  templateUrl: './decode-tab.component.html',
  styleUrls: ['./decode-tab.component.scss']
})

export class TxBuilderDecodeTabComponent {
  @Output('loading') loadingEmmiter: EventEmitter<boolean> = new EventEmitter();
  private _loading: boolean = false;
  private _rawTx: string = '';

  public decodeData: string = '';
  public tlDecodeData: string = '';

  constructor(
    private rpcService: RpcService,
    private toastrService: ToastrService,
  ) { }

  get rawTx() {
    return this._rawTx;
  }

  set rawTx(value: string) {
    this._rawTx = value;
  }

  get loading() {
    return this._loading;
  }

  set loading(value: boolean) {
    this.loadingEmmiter.emit(value);
    this._loading = value;
  }

  async decode() {
    this.loading = true;
    const decodeData = await this.rpcService.rpc('decoderawtransaction', [this.rawTx]);
    if (decodeData.error || !decodeData.data) {
      this.decodeData = JSON.stringify(decodeData.error, null, 4);
    } else {
      this.decodeData = JSON.stringify(decodeData.data, null, 4);
    }

    const tlDecodeData = await this.rpcService.rpc('tl_decodetransaction', [this.rawTx]);
    if (tlDecodeData.error || !tlDecodeData.data) {
      this.tlDecodeData = JSON.stringify(tlDecodeData.error, null, 4);
    } else {
      this.tlDecodeData = JSON.stringify(tlDecodeData.data, null, 4);
    }
  
    this.loading = false;
  }
}
