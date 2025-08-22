import { Component, NgZone } from '@angular/core';
import { AttestationService } from './@core/services/attestation.service';
import { BalanceService } from './@core/services/balance.service';
import { ConnectionService } from './@core/services/connections.service';
import { ElectronService } from './@core/services/electron.service';
import { LoadingService } from './@core/services/loading.service';
import { NodeRewardService } from './@core/services/node-reward.service';
import { RpcService } from './@core/services/rpc.service';
import { SocketService } from './@core/services/socket.service';
import { SwapService } from './@core/services/swap.service';
import { WindowsService } from './@core/services/windows.service';
import {SpotTradeHistoryService} from './@core/services/spot-services/spot-trade-history.service'
import {FuturesTradeHistoryService} from './@core/services/futures-services/futures-trade-history.service'
import {SpotChannelsService} from './@core/services/spot-services/spot-channels.service'
import {FuturesChannelsService} from './@core/services/futures-services/futures-channels.service'

@Component({
  selector: 'tl-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss']
})
export class AppComponent {
  private isOnline: boolean = this.connectionService.isOnline;
  constructor(
    private rpcService: RpcService,
    private connectionService: ConnectionService,
    private ngZone: NgZone,
    private loadingService: LoadingService,
    private electronService: ElectronService,
    private windowsService: WindowsService,
    private attestationService: AttestationService,
    private balanceService: BalanceService,
    private socketService: SocketService,
    private swapService: SwapService,
    private nodeRewardService: NodeRewardService,
    private spotHistory: SpotTradeHistoryService,
    private futHistory: FuturesTradeHistoryService,
    private spotChannels: SpotChannelsService,
    private futChannels: FuturesChannelsService
  ) {
    this.handleInits();
    this.handleConnections();
    this.handleElectronEvents();
  }

  get windows() {
    return this.windowsService.tabs;
  }

  get isLoading() {
    return this.loadingService.isLoading;
  }

  set isLoading(value: boolean) {
    this.loadingService.isLoading = value;
  }

  get isCoreStarted() {
    return this.rpcService.isCoreStarted;
  }

  get isNetworkSelected() {
    return this.rpcService.isNetworkSelected;
  }

  get socketsLoading() {
    return this.socketService.socketsLoading;
  }

  get allConnected() {
    return this.isOnline && this.connectionService.isMainSocketConnected;
  }

  handleInits() {
    console.log('initializing services ')
    this.connectionService.onInit();
    this.rpcService.onInit();
    this.balanceService.onInit();
    this.attestationService.onInit();
    this.swapService.onInit();
    this.nodeRewardService.onInit();
    this.spotHistory.start()
    this.futHistory.start()
    this.spotChannels.startPolling()
    this.futChannels.startPolling()
  }

  handleConnections() {
    this.connectionService.isOnline$
      .subscribe((isOnline) => {
        this.ngZone.run(() => this.isOnline = isOnline);
      })
  }

  handleElectronEvents() {
    this.electronService.ipcRenderer
      .on('angular-electron-message', (_: any, message: any) => {
        const { event, data } = message;
        if (event === 'close-app' && data === true) {
          this.ngZone.run(() => this.isLoading = true);
        }
      });
  }

  openHiddenTerminal() {
    this.windowsService.openTerminal();
  }
}
