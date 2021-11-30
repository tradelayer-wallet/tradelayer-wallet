import { Component, OnInit } from '@angular/core';
import { RpcService } from 'src/app/@core/services/rpc.service';
import { SocketService } from 'src/app/@core/services/socket.service';
import { IWindow, WindowsService } from 'src/app/@core/services/windows.service';

@Component({
  selector: 'tl-info-line',
  templateUrl: './info-line.component.html',
  styleUrls: ['./info-line.component.scss']
})

export class InfoLineComponent implements OnInit {
  blockHigh: number = 0;

  constructor(
    private socketService: SocketService,
    private rpcService: RpcService,
    private windowsService: WindowsService,
  ) { }

  get socket() {
    return this.socketService.socket;
  }

  get network() {
    return this.rpcService.NETWORK === 'LTCTEST' ? 'TESTNET' : 'MAINNET';
  }

  get windows() {
    return this.windowsService.tabs;
  }

  ngOnInit() {
    this._trackBlockHigh();
  }

  private async _trackBlockHigh() {
    const giRes = await this.rpcService.rpc('tl_getinfo');
    if (!giRes.error || giRes.data?.block) this.blockHigh = giRes.data.block;
    this.socket.on('newBlock', (block: number) => this.blockHigh = block);
  }

  maximize(event: Event, tab: IWindow) {
    event.stopImmediatePropagation();
    tab.minimized = !tab.minimized;
  }
}
