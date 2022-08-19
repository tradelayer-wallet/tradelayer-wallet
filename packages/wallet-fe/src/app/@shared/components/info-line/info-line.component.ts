import { Component, ElementRef, OnInit, ViewChild } from '@angular/core';
import { RpcService } from 'src/app/@core/services/rpc.service';
// import { SocketService } from 'src/app/@core/services/socket.service';
import { IWindow, WindowsService } from 'src/app/@core/services/windows.service';
const mainPackageJson = require('../../../../../../../package.json');

@Component({
  selector: 'tl-info-line',
  templateUrl: './info-line.component.html',
  styleUrls: ['./info-line.component.scss']
})

export class InfoLineComponent implements OnInit {
  @ViewChild('newBlock') newBlockElement: ElementRef<HTMLSpanElement> | null = null; 
  blockHigh: number = 0;

  constructor(
    // private socketService: SocketService,
    private rpcService: RpcService,
    private windowsService: WindowsService,
  ) { }

  // get isAbleToRpc() {
  //   return this.rpcService.isAbleToRpc;
  // }

  // get isApiRPC() {
  //   return this.rpcService.isApiRPC;
  // }

  // get socket() {
  //   return this.socketService.socket;
  // }

  get network() {
    return this.rpcService.NETWORK;
  }

  get windows() {
    return this.windowsService.tabs;
  }

  get lastBlock() {
    return this.rpcService.lastBlock;
  }

  get networkBlock() {
    return this.rpcService.networkBlocks;
  }

  get isSynced() {
    return this.rpcService.isSynced;
  }

  get isApiMode() {
    return this.rpcService.isApiMode;
  }

  get walletVersion() {
    return `v${mainPackageJson.version}`;
  }

  get isCoreStarted() {
    return this.rpcService.isCoreStarted;
  }

  ngOnInit() {
    this.rpcService.blockSubs$
      .subscribe(() => {
        if (this.newBlockElement?.nativeElement?.classList) {
          this.newBlockElement.nativeElement.classList.add('active-animation');
          setTimeout(() => {
            if (this.newBlockElement?.nativeElement?.classList) {
              this.newBlockElement.nativeElement.classList.remove('active-animation');
            }
          }, 5000);
        }
      });
  }

  maximize(event: Event, tab: IWindow) {
    event.stopImmediatePropagation();
    tab.minimized = !tab.minimized;
  }
}
