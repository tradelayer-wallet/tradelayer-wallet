import { Component, EventEmitter, Output } from '@angular/core';
import { ToastrService } from 'ngx-toastr';
import { RpcService } from 'src/app/@core/services/rpc.service';

@Component({
  selector: 'tx-builder-send-tab',
  templateUrl: './send-tab.component.html',
  styleUrls: ['./send-tab.component.scss']
})

export class TxBuilderSendTabComponent {
  @Output('loading') loadingEmmiter: EventEmitter<boolean> = new EventEmitter();
  private _loading: boolean = false;

  public rawTx: string = '';
  public successMessage: string = '';

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

  async send(){
    this.loading = true;
    this.successMessage = '';
    const hex = this.rawTx;
    const resSend = await this.rpcService.rpc('sendrawtransaction', [hex]);
    resSend.error || !resSend.data
      ? this.toastrService.error(resSend.error || 'Undefined Error!', 'Error')
      : this.successMessage = resSend.data;
    this.loading = false;
  }

  copy(text: string) {
    navigator.clipboard.writeText(text);
    this.toastrService.info('Address Copied to clipboard', 'Copied')
  }
}
