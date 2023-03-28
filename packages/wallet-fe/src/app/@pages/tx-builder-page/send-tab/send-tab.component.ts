import { Component, OnInit } from '@angular/core';
import { ToastrService } from 'ngx-toastr';
import { RpcService } from 'src/app/@core/services/rpc.service';

@Component({
  selector: 'tl-send-tab',
  templateUrl: './send-tab.component.html',
  styleUrls: ['./send-tab.component.scss']
})
export class SendTxTabComponent implements OnInit {
  output: string = '';
  input: string = '';
  
  constructor(
    private toastrService: ToastrService,
    private rpcService: RpcService,
  ) {}

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

  send() {
    this.rpcService.rpc('sendrawtransaction', [this.input])
      .then(res => this.output = JSON.stringify(res, null, 4))
      .catch(error => {
        this.output = `Error: ${error.message || error || 'Undefined'}`;
      });
  }
}
