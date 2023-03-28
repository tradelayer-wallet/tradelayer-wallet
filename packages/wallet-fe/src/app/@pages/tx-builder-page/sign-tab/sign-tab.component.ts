import { Component, OnInit } from '@angular/core';
import { ToastrService } from 'ngx-toastr';
import { AuthService, IKeyPair } from 'src/app/@core/services/auth.service';
import { RpcService } from 'src/app/@core/services/rpc.service';
import { TxsService, ISignTxConfig } from '../../../@core/services/txs.service';

@Component({
  selector: 'tl-sign-tab',
  templateUrl: './sign-tab.component.html',
  styleUrls: ['./sign-tab.component.scss']
})
export class SignTxTabComponent implements OnInit {
  output: string = '';
  _input: string = '';
  vins: any[] = [];
  _keyType: 'WALLET' | 'CUSTOM'  = 'CUSTOM';
  privKey: string = '';

  constructor(
    private toastrService: ToastrService,
    private authService: AuthService,
    private txsService: TxsService,
    private rpcService: RpcService,
  ) {}

  get keyType() {
    return this._keyType;
  }

  set keyType(value: 'WALLET' | 'CUSTOM') {
    this.privKey = '';
    this._keyType = value;
  }

  get input() {
    return this._input;
  }

  set input(value: string) {
    this._input = value;
    this.updateInputs();
  }

  get keypairs() {
    return this.authService.listOfallAddresses;
  }

  get isLoggedIn() {
    return this.authService.isLoggedIn;
  }

  ngOnInit() { }

  async pasteClipboard() {
    const text = await navigator.clipboard.readText();
    this.input = text;
  }

  copyOutput() {
    if (!this.output) return;
    navigator.clipboard.writeText(this.output);
    this.toastrService.info('RawTX Copied to clipboard', 'Copied');
  }

  sign() {
    this.output = '';
    const wif = this.privKey
    const inputs = this.vins;
    const rawtx = this.input;
    const options: ISignTxConfig = { inputs, wif, rawtx };
    this.txsService.signTx(options)
      .then(res => this.output = JSON.stringify(res, null, 4))
      .catch(error => {
        this.output = `Error: ${error.message || error || 'Undefined'}`;
      });
  }

  private async updateInputs() {
    if (!this.input) {
      this.output = `// Output`
      return;
    }
    try {
      this.vins = [];
      const decodeRes = await this.rpcService.rpc('decoderawtransaction', [this.input]);
      if (decodeRes.error || !decodeRes.data?.vin?.length) {
        this.output = `Error: ${decodeRes.error || 'Undefined'}`;
        return;
      }
      this.vins = decodeRes.data.vin.map((i: any) => ({ txid: i.txid, vout: i.vout }));
    } catch (error: any) {
      this.output = `Error: ${error.message || error || 'Undefined'}`
    }
  }
}
