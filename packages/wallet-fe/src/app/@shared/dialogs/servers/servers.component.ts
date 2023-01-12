import { Component, OnDestroy, OnInit } from '@angular/core';
import { ToastrService } from 'ngx-toastr';
import { ApiService } from 'src/app/@core/services/api.service';
import { ConnectionService } from 'src/app/@core/services/connections.service';
import { LoadingService } from 'src/app/@core/services/loading.service';
import { RpcService } from 'src/app/@core/services/rpc.service';
import { obEventPrefix, SocketService } from 'src/app/@core/services/socket.service';
import { environment } from 'src/environments/environment';

@Component({
  selector: 'servers-dialog',
  templateUrl: './servers.component.html',
  styleUrls: ['./servers.component.scss']
})
export class ServersDialog implements OnInit, OnDestroy {
  public orderbookServers: string[] = [environment.ENDPOINTS?.[this.network]?.orderbookApiUrl, '@custom'];
  public apiServers: string[] = [environment.ENDPOINTS?.[this.network]?.relayerUrl, '@custom'];

  public customApiUrl: string = '';
  public customOrderbookUrl: string = '';

  selectedOrderbookServer: string = this.orderbookServers[0];
  selectedApiServer: string = this.apiServers[0];

  constructor(
    private socketService: SocketService,
    private rpcService: RpcService,
    private connectionService: ConnectionService,
    private toastrService: ToastrService,
    private apiService: ApiService,
    private loadingService: LoadingService,
  ) {}

  get isOrderbookConnected() {
    return this.connectionService.isOBSocketConnected;
  }

  get isApiConnected() {
    return !!this.apiService.apiUrl;
  }

  get network() {
    return this.rpcService.NETWORK as string;
  }

  ngOnInit() {
    this.socketService.socket.on(`${obEventPrefix}::connect`, () => {
      const orderbookUrl = this.selectedOrderbookServer === "@custom"
        ? this.customOrderbookUrl
        : this.selectedOrderbookServer;
      this.apiService.orderbookUrl = orderbookUrl;
    });

    this.socketService.socket.on(`${obEventPrefix}::disconnect`, () => {
      this.apiService.orderbookUrl = null;
    });
  }

  ngOnDestroy() { }

  selectOrderbookServer(url: string) {
    if (this.selectedOrderbookServer === url) return;
    if (this.isOrderbookConnected) {
      this.toastrService.warning('First disconnect to the connected server');
      return;
    }
    this.selectedOrderbookServer = url;
    this.customOrderbookUrl = '';
  }

  connectOrderbookServer() {
    const orderbookUrl = this.selectedOrderbookServer === "@custom"
      ? this.customOrderbookUrl
      : this.selectedOrderbookServer;
    this.socketService.obSocketConnect(orderbookUrl);
  }
  
  disconnectOrderbookServer() {
    this.socketService.obSocketDisconnect();
  }

  selectApiServer(url: string) {
    if (this.selectedApiServer === url) return;
    if (this.isApiConnected) {
      this.toastrService.warning('First disconnect to the connected server');
      return;
    }
    this.selectedApiServer = url;
    this.customApiUrl = '';
  }

  async connectApiServer() {
    try {
      this.loadingService.isLoading = true;
      const apiUrl = this.selectedApiServer === "@custom"
        ? this.customApiUrl
        : this.selectedApiServer;
      this.apiService.apiUrl = apiUrl;
      await this.rpcService.checkNetworkInfo();
      this.loadingService.isLoading = false;
    } catch (error: any) {
      this.toastrService.error(error.message, 'Connection Error');
      this.loadingService.isLoading = false;
    }
  }

  disconnectApiServer() {
    this.apiService.apiUrl = null;
  }
}
