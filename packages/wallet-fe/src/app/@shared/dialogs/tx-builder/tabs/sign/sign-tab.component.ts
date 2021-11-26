import { Component, Output, EventEmitter } from '@angular/core';
import { ToastrService } from 'ngx-toastr';
import { RpcService } from 'src/app/@core/services/rpc.service';

@Component({
  selector: 'tx-builder-sign-tab',
  templateUrl: './sign-tab.component.html',
  styleUrls: ['./sign-tab.component.scss']
})

export class TxBuilderSignTabComponent {
  @Output('loading') loadingEmmiter: EventEmitter<boolean> = new EventEmitter();
  private _nRequired: number = 2;
  private _loading: boolean = false;
  public _rawTx: string = '';
  public hexOutput: string = '';
  public complete: boolean = false;
  public vins: any[] = [];
  public detailed: boolean = false;
  public errorsObj: any;

  public addMultisig: boolean = false;
  public pubkeysArray: string[] = ['',''];

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

  get rawTx() {
    return this._rawTx;
  }

  set rawTx(value: string) {
    this._rawTx = value;
    this.update();
  }

  get errorsString() {
    if (!this.errorsObj) return '';
    return this.errorsObj.map((e: any) => `1.${e.error}`).join('\n');
  }

  get buttonDisabled() {
    if (!this.rawTx) return true;
    if (!this.detailed) return !this.vins.length;
    if (!this.vins.length) return true;
    return !this.vins.every((tx: any) => tx.redeemScript && tx.amount && tx.scriptPubKey && tx.txid && (tx.vout || tx.vout === 0));
  }

  get nRequired() {
      return this._nRequired;
  }

  set nRequired(value: number) {
      this._nRequired = value;
  }

  changePubKey(event: any, index: number) {
    const { value } = event.target;
    this.pubkeysArray[index] = value;
  }

  nKeysChange(keysType: 'required' | 'all', action: 'add' | 'remove') {
    if (keysType === 'required'){
        if (action === 'add') {
            this.nRequired < this.pubkeysArray.length
                ? this.nRequired = this.nRequired + 1
                : null
        }
        if (action === 'remove') {
            this.nRequired > 2
            ? this.nRequired = this.nRequired - 1
            : null
        }
    }

    if (keysType === 'all'){
        if (action === 'add') {
            this.pubkeysArray.length < 7
                ? this.pubkeysArray.push('')
                : null
        }
        if (action === 'remove') {
            this.pubkeysArray.length > 2
                ? this.pubkeysArray.pop()
                : null

            this.nRequired > this.pubkeysArray.length
                ? this.nRequired = this.pubkeysArray.length
                : null
        }
    }
}

  async update() {
    this.vins = [];
    const decodeRes = await this.rpcService.rpc('decoderawtransaction', [this.rawTx]);
    if (decodeRes.error || !decodeRes.data?.vin?.length) {
      this.vins = [];
      return;
    }
    this.vins = decodeRes.data.vin.map((i: any) => ({ txid: i.txid, vout: i.vout }));
  }

  async sign() {
    this.hexOutput = '';
    this.loading = true;
    this.complete = false;
    this.errorsObj = null;
    if (this.addMultisig) {
      const amsRes = await this.rpcService.rpc('addmultisigaddress', [this.nRequired, this.pubkeysArray]);
      if (amsRes.error || !amsRes.data) {
        this.toastrService.error(amsRes.error || `Unknown Error`, 'Adding Multisig')
      }
    }
    const res = !this.detailed
      ? await this.rpcService.rpc('signrawtransaction', [this.rawTx])
      : await this.rpcService.rpc('signrawtransaction', [this.rawTx, this.vins])
    if (res.error || !res.data) {
      this.toastrService.error(res.error || 'Unknown Error', 'Signing Error');
    } else {
      const { hex, complete, errors } = res.data;
      this.complete = complete;
      this.hexOutput = hex;
      if (errors) this.errorsObj = errors;
    }
    this.loading = false;
  }

  copy(text: string) {
    navigator.clipboard.writeText(text);
    this.toastrService.info('Address Copied to clipboard', 'Copied')
  }
}
