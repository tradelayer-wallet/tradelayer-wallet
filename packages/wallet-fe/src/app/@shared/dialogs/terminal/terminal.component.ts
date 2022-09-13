import { Component } from '@angular/core';
import { ToastrService } from 'ngx-toastr';
import { ApiService } from 'src/app/@core/services/api.service';
import { RpcService } from 'src/app/@core/services/rpc.service';

@Component({
  selector: 'terminal-dialog',
  templateUrl: './terminal.component.html',
  styleUrls: ['./terminal.component.scss']
})
export class TerminalDialog  {
  input: string = '';
  textArea: string = '';
  typeRpc: "LOCAL" | "API" = 'LOCAL';

  constructor(
    private apiService: ApiService,
    private rpcService: RpcService,
    private toastrService: ToastrService,
  ) {}

  get tlApi() {
    return this.apiService.tlApi;
  }

  get mainApi() {
    return this.apiService.mainApi;
  }

  sendRPC() {
    if (!this.input?.length || !this.typeRpc) return;
    const inputSplit = this.input.split(' ');
    if (!inputSplit.length) return;
    const method = inputSplit[0];
    const params = inputSplit.length > 1
      ? inputSplit.slice(1).filter(p => p).map(p => isNaN(parseFloat(p)) ? p : parseFloat(p))
      : [];
    this.textArea += `\n${this.input}\n`;
    if (this.typeRpc === "LOCAL") {
      this.mainApi.rpcCall(method, params).toPromise()
        .then(res => {
          if (!res.data || res.error) throw new Error(res.error || `${method}: Undefined Error`);
          this.textArea += `\n${JSON.stringify(res.data, null, 2)}\n=======================================\n`;
        })
        .catch(error => {
          this.textArea += `\n${method} ERROR: ${error.message}\n=======================================\n`
        });
    }

    if (this.typeRpc === "API") {
      this.tlApi.rpc(method, params).toPromise()
      .then(res => {
        if (!res.data || res.error) throw new Error(res.error || `${method}: Undefined Error`);
        this.textArea += `\n${JSON.stringify(res.data, null, 2)}\n=======================================\n`;
      })
      .catch(error => {
        this.textArea += `\n${method} ERROR: ${error.message}\n=======================================\n`
      });
    }

    this.input = '';
  }
}
