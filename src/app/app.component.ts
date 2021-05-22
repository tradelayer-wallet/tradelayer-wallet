import { Component } from '@angular/core';
import { RpcService } from './@core/services/rpc.service';
import { environment } from '../environments/environment';

@Component({
  selector: 'tl-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss']
})
export class AppComponent {
  constructor(
    private rpcService: RpcService,
  ) {}

  get isConnected() {
    if (environment.rpcRequire === false) return true;
    return this.rpcService.isConnected;
  }
}
