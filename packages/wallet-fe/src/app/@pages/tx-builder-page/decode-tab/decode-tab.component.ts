import { Component, OnInit } from '@angular/core';
import { ToastrService } from 'ngx-toastr';
import { RpcService } from 'src/app/@core/services/rpc.service';

@Component({
  selector: 'tl-decode-tab',
  templateUrl: './decode-tab.component.html',
  styleUrls: ['./decode-tab.component.scss']
})
export class DecodeTxTabComponent implements OnInit {
  output_main: string = '';
  output_tl: string = '';

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

  copyOutput(n: number) {
    const output = n === 1
      ? this.output_tl
      : n === 2
        ? this.output_main
        : null;
    if (!output) return;
    navigator.clipboard.writeText(output);
    this.toastrService.info('Copied to clipboard', 'Copied');

  }

  decode() {
    this.rpcService.rpc('decoderawtransaction', [this.input])
      .then(res => this.output_main = JSON.stringify(res, null, 4))
      .catch(error => {
        this.output_main = `Error: ${error.message || error || 'Undefined'}`;
      });

    this.rpcService.rpc('tl_decodetransaction', [this.input])
      .then(res => this.output_tl = JSON.stringify(res, null, 4))
      .catch(error => {
        this.output_tl = `Error: ${error.message || error || 'Undefined'}`;
      });
  }
}
