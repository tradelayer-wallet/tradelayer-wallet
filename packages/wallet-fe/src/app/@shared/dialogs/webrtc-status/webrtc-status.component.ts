import { Component, OnDestroy, OnInit } from '@angular/core';
import { ToastrService } from 'ngx-toastr';
import { ApiService } from 'src/app/@core/services/api.service';
import { LoadingService } from 'src/app/@core/services/loading.service';
import { WindowsService } from 'src/app/@core/services/windows.service';

function normalizeWsUrl(value: string): string {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (!parsed.pathname || parsed.pathname === '/') {
      parsed.pathname = '/ws';
    } else if (!parsed.pathname.endsWith('/ws')) {
      parsed.pathname = parsed.pathname.replace(/\/+$/, '') + '/ws';
    }
    return parsed.toString().replace(/\/+$/, '').replace(/\/ws$/, '/ws');
  } catch {
    return raw.endsWith('/ws') ? raw : `${raw.replace(/\/+$/, '')}/ws`;
  }
}

@Component({
  selector: 'webrtc-status-dialog',
  templateUrl: './webrtc-status.component.html',
  styleUrls: ['./webrtc-status.component.scss'],
})
export class WebrtcStatusDialog implements OnInit, OnDestroy {
  public collatorStatus: any = null;
  public collatorUrlsText: string = '';
  public autoContribute: boolean = true;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private apiService: ApiService,
    private loadingService: LoadingService,
    private windowsService: WindowsService,
    private toastrService: ToastrService,
  ) {}

  ngOnInit(): void {
    void this.loadCollatorStatus();
    this.startRefresh();
  }

  ngOnDestroy(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private startRefresh() {
    if (this.refreshTimer) return;
    this.refreshTimer = setInterval(() => void this.loadCollatorStatus(), 5000);
  }

  async loadCollatorStatus() {
    try {
      const res = await this.apiService.mainApi.getTradeLayerCollatorStatus().toPromise();
      const status = res?.data || {};
      this.collatorStatus = status;
      this.collatorUrlsText = (status.collatorUrls || [])
        .map((url: string) => normalizeWsUrl(url))
        .join('\n');
      if (typeof status.autoContributeEnabled === 'boolean') {
        this.autoContribute = status.autoContributeEnabled;
      }
    } catch {
      this.collatorStatus = null;
    }
  }

  async saveCollatorConfig() {
    try {
      this.loadingService.isLoading = true;
      const urls = (this.collatorUrlsText || '')
        .split(/[\n,]+/)
        .map((s) => s.trim())
        .map((s) => normalizeWsUrl(s))
        .filter(Boolean);
      const res = await this.apiService.mainApi.setTradeLayerCollatorConfig({
        collatorUrls: urls,
        autoContribute: this.autoContribute,
      }).toPromise();
      this.collatorStatus = res?.data || null;
      await this.loadCollatorStatus();
      this.toastrService.success('Collator settings saved', 'P2P');
    } catch (error: any) {
      this.toastrService.error(error?.message || error || 'Undefined Error', 'P2P');
    } finally {
      this.loadingService.isLoading = false;
    }
  }

  openServers() {
    const current = this.windowsService.tabs.find((window) => window.title === 'WebRTC');
    if (current) {
      current.minimized = true;
    }

    const tab = this.windowsService.tabs.find((window) => window.title === 'Servers');
    if (tab) {
      tab.minimized = false;
    }
  }

  get activePeers(): string[] {
    return Array.isArray(this.collatorStatus?.activePeers) ? this.collatorStatus.activePeers : [];
  }

  get peerCount(): number {
    return Number(this.collatorStatus?.activePeerCount || this.activePeers.length || 0);
  }

  get providerCount(): number {
    return Number(
      this.collatorStatus?.activePeerCount
      || this.activePeers.length
      || this.collatorStatus?.rpcProviders
      || this.collatorStatus?.providerCount
      || 0
    );
  }

  get readiness(): string {
    return String(this.collatorStatus?.shouldContributeReason || 'unknown');
  }

  get relaySession(): any {
    return this.collatorStatus?.wsRelay || null;
  }

  get packetsReceived(): number {
    return Number(this.relaySession?.receivedPackets || 0);
  }

  get packetsReplied(): number {
    return Number(this.relaySession?.repliedPackets || 0);
  }
}
