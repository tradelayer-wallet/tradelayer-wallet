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
  public orderbookServers: string[] = [];
  public apiServers: string[] = [];

  public customApiUrl: string = '';
  public customOrderbookUrl: string = '';

  selectedOrderbookServer: string = '';
  selectedApiServer: string = '';

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
    this.syncServerDefaults();

    this.socketService.socket.on(`${obEventPrefix}::connect`, () => {
      const orderbookUrl = this.getSelectedOrderbookUrl();
      this.apiService.orderbookUrl = orderbookUrl;
    });

    this.socketService.socket.on(`${obEventPrefix}::disconnect`, () => {
      this.apiService.orderbookUrl = null;
    });
  }

  ngOnDestroy() {
  }

  private getNetworkDefaults() {
    const current = environment.ENDPOINTS?.[this.network];
    const fallback = current || environment.ENDPOINTS?.LTC || environment.ENDPOINTS?.LTCTEST || environment.ENDPOINTS?.BTC;

    return {
      orderbookUrl: current?.orderbookApiUrl || fallback?.orderbookApiUrl || '',
      apiUrl: current?.relayerUrl || fallback?.relayerUrl || '',
    };
  }

  private syncServerDefaults() {
    const defaults = this.getNetworkDefaults();
    this.orderbookServers = [defaults.orderbookUrl, '@custom'];
    this.apiServers = [defaults.apiUrl, '@custom'];

    if (!this.selectedOrderbookServer || (this.selectedOrderbookServer !== '@custom' && !this.orderbookServers.includes(this.selectedOrderbookServer))) {
      this.selectedOrderbookServer = defaults.orderbookUrl;
    }

    if (!this.selectedApiServer || (this.selectedApiServer !== '@custom' && !this.apiServers.includes(this.selectedApiServer))) {
      this.selectedApiServer = defaults.apiUrl;
    }
  }

  private getSelectedOrderbookUrl() {
    const url = this.selectedOrderbookServer === '@custom' ? this.customOrderbookUrl : this.selectedOrderbookServer;
    return (url || '').trim();
  }

  private getSelectedApiUrl() {
    const url = this.selectedApiServer === '@custom' ? this.customApiUrl : this.selectedApiServer;
    return (url || '').trim();
  }

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
    const orderbookUrl = this.getSelectedOrderbookUrl();
    if (!orderbookUrl) {
      this.toastrService.error('Orderbook server URL is required', 'Connection Error');
      return;
    }

    this.apiService.orderbookUrl = orderbookUrl;
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
      const apiUrl = this.getSelectedApiUrl();
      if (!apiUrl) {
        this.toastrService.error('API server URL is required', 'Connection Error');
        return;
      }

      this.loadingService.isLoading = true;
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
