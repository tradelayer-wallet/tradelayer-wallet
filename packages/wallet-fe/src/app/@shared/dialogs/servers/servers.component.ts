import { Component, OnDestroy, OnInit } from '@angular/core';
import { ToastrService } from 'ngx-toastr';
import { ApiService } from 'src/app/@core/services/api.service';
import { ConnectionService } from 'src/app/@core/services/connections.service';
import { LoadingService } from 'src/app/@core/services/loading.service';
import { P2PSettingsService } from 'src/app/@core/services/p2p-settings.service';
import { P2PTransportService } from 'src/app/@core/services/p2p-transport.service';
import { RpcService } from 'src/app/@core/services/rpc.service';
import { obEventPrefix, SocketService } from 'src/app/@core/services/socket.service';
import { environment } from 'src/environments/environment';
import type { ConnectivityMode } from 'src/p2p/policy/RoutingPolicy';

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

  p2pMode: ConnectivityMode = 'CENTRAL';
  collatorUrlsText: string = '';
  requireVerifiedManifest: boolean = true;
  allowedCollatorIdsText: string = '';
  enforceClearlistSubmitter: boolean = false;
  requireInfraAttestation: boolean = false;
  requiredClearlistId: string = '';

  constructor(
    private socketService: SocketService,
    private rpcService: RpcService,
    private connectionService: ConnectionService,
    private toastrService: ToastrService,
    private apiService: ApiService,
    private loadingService: LoadingService,
    private p2pSettings: P2PSettingsService,
    private p2pTransport: P2PTransportService,
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

  get isP2PConnected() {
    return this.p2pTransport.isConnected;
  }

  get p2pPrimaryUrl() {
    return this.p2pTransport.primaryStatus.collatorUrl || '';
  }

  get p2pBackupUrl() {
    return this.p2pTransport.backupStatus.collatorUrl || '';
  }

  get p2pRtt() {
    return this.p2pTransport.primaryStatus.rttMs ?? null;
  }

  get p2pWarning() {
    return this.p2pTransport.audit.warning || '';
  }

  get p2pPrimaryManifest() {
    return this.p2pTransport.audit.primaryManifest || null;
  }

  get p2pBackupManifest() {
    return this.p2pTransport.audit.backupManifest || null;
  }

  get p2pPrimaryApproval() {
    return this.p2pTransport.audit.primaryApproval || null;
  }

  get p2pBackupApproval() {
    return this.p2pTransport.audit.backupApproval || null;
  }

  ngOnInit() {
    this.p2pMode = this.p2pSettings.mode;
    this.collatorUrlsText = (this.p2pSettings.collatorUrls || []).join('\n');
    this.requireVerifiedManifest = this.p2pSettings.requireVerifiedManifest;
    this.allowedCollatorIdsText = (this.p2pSettings.allowedCollatorIds || []).join('\n');
    this.enforceClearlistSubmitter = this.p2pSettings.enforceClearlistSubmitter;
    this.requireInfraAttestation = this.p2pSettings.requireInfraAttestation;
    this.requiredClearlistId = this.p2pSettings.requiredClearlistId;

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

  onP2PModeChange(mode: ConnectivityMode) {
    if (this.isP2PConnected) {
      this.toastrService.warning('Disconnect P2P first');
      this.p2pMode = this.p2pSettings.mode;
      return;
    }
    this.p2pMode = mode;
    this.p2pSettings.setMode(mode);
  }

  onRequireVerifiedManifestChange(v: boolean) {
    if (this.isP2PConnected) {
      this.toastrService.warning('Disconnect P2P first');
      this.requireVerifiedManifest = this.p2pSettings.requireVerifiedManifest;
      return;
    }
    this.requireVerifiedManifest = !!v;
    this.p2pSettings.setRequireVerifiedManifest(!!v);
  }

  onEnforceClearlistSubmitterChange(v: boolean) {
    if (this.isP2PConnected) {
      this.toastrService.warning('Disconnect P2P first');
      this.enforceClearlistSubmitter = this.p2pSettings.enforceClearlistSubmitter;
      return;
    }
    this.enforceClearlistSubmitter = !!v;
    this.p2pSettings.setEnforceClearlistSubmitter(!!v);
  }

  onRequireInfraAttestationChange(v: boolean) {
    if (this.isP2PConnected) {
      this.toastrService.warning('Disconnect P2P first');
      this.requireInfraAttestation = this.p2pSettings.requireInfraAttestation;
      return;
    }
    this.requireInfraAttestation = !!v;
    this.p2pSettings.setRequireInfraAttestation(!!v);
  }

  onRequiredClearlistIdChange(v: string) {
    if (this.isP2PConnected) {
      this.toastrService.warning('Disconnect P2P first');
      this.requiredClearlistId = this.p2pSettings.requiredClearlistId;
      return;
    }
    this.requiredClearlistId = String(v || '').trim();
    this.p2pSettings.setRequiredClearlistId(this.requiredClearlistId);
  }

  saveCollatorUrls() {
    const urls = (this.collatorUrlsText || '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    this.p2pSettings.setCollatorUrls(urls);
  }

  saveAllowedCollatorIds() {
    const ids = (this.allowedCollatorIdsText || '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    this.p2pSettings.setAllowedCollatorIds(ids);
  }

  async connectP2P() {
    try {
      this.saveCollatorUrls();
      this.saveAllowedCollatorIds();
      this.p2pSettings.setRequireVerifiedManifest(!!this.requireVerifiedManifest);
      this.p2pSettings.setEnforceClearlistSubmitter(!!this.enforceClearlistSubmitter);
      this.p2pSettings.setRequireInfraAttestation(!!this.requireInfraAttestation);
      this.p2pSettings.setRequiredClearlistId(this.requiredClearlistId);
      if (!this.p2pSettings.collatorUrls.length) {
        this.toastrService.error('Add at least one collator URL', 'P2P');
        return;
      }
      this.loadingService.isLoading = true;
      await this.p2pTransport.start();
    } catch (e: any) {
      this.toastrService.error(e?.message || String(e), 'P2P Connect Error');
    } finally {
      this.loadingService.isLoading = false;
    }
  }

  async disconnectP2P() {
    await this.p2pTransport.stop();
  }
}
