import { Component } from '@angular/core';
import { RpcService } from './@core/services/rpc.service';

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
    return this.rpcService.isConnected;
  }
}
