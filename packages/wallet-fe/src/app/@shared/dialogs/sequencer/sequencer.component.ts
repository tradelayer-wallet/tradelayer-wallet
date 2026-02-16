import { Component, OnDestroy, OnInit } from '@angular/core';
import { ToastrService } from 'ngx-toastr';
import { LoadingService } from 'src/app/@core/services/loading.service';
import { CollatorHostService } from 'src/app/@core/services/collator-host.service';
import type { CollatorStartRequest, CollatorStatus } from 'src/app/@core/apis/collator-api.service';
import { P2PSettingsService } from 'src/app/@core/services/p2p-settings.service';
import { RustSequencerHostService } from 'src/app/@core/services/rust-sequencer-host.service';
import type { RustSequencerStartRequest, RustSequencerStatus } from 'src/app/@core/apis/rust-sequencer-api.service';

@Component({
  selector: 'sequencer-dialog',
  templateUrl: './sequencer.component.html',
  styleUrls: ['./sequencer.component.scss']
})
export class SequencerDialog implements OnInit, OnDestroy {
  status: CollatorStatus | null = null;
  rustStatus: RustSequencerStatus | null = null;

  port: number = 8787;
  wsPath: string = '/ws';
  dataDir: string = '';
  entryPath: string = '';

  clearlistEnforce: boolean = false;
  clearlistUrl: string = '';
  clearlistFailMode: 'closed' | 'open' = 'closed';

  rustPort: number = 8000;
  rustWsPath: string = '/ws';
  rustDataDir: string = '';
  rustExePath: string = '';
  rustArgs: string = '';

  constructor(
    private host: CollatorHostService,
    private rustHost: RustSequencerHostService,
    private toastr: ToastrService,
    private loading: LoadingService,
    private p2pSettings: P2PSettingsService,
  ) {}

  get wsUrl(): string {
    const p = this.status?.wsUrl;
    if (p) return p;
    if (!this.port) return '';
    const w = (this.wsPath || '/ws').startsWith('/') ? (this.wsPath || '/ws') : '/' + (this.wsPath || 'ws');
    return `ws://127.0.0.1:${this.port}${w}`;
  }

  async ngOnInit() {
    await this.refresh();
    if (this.status?.port) this.port = this.status.port;
    if (this.status?.wsPath) this.wsPath = this.status.wsPath;
    if (this.status?.dataDir) this.dataDir = this.status.dataDir;
    if (this.status?.entryPath) this.entryPath = this.status.entryPath;

    await this.refreshRust();
    if (this.rustStatus?.port) this.rustPort = this.rustStatus.port;
    if (this.rustStatus?.wsPath) this.rustWsPath = this.rustStatus.wsPath;
    if (this.rustStatus?.dataDir) this.rustDataDir = this.rustStatus.dataDir;
    if (this.rustStatus?.exePath) this.rustExePath = this.rustStatus.exePath;
    if (this.rustStatus?.args) this.rustArgs = this.rustStatus.args;
  }

  ngOnDestroy() {}

  async refresh() {
    try {
      this.status = await this.host.status();
    } catch (e: any) {
      this.toastr.error(e?.message || String(e), 'Sequencer');
    }
  }

  async refreshRust() {
    try {
      this.rustStatus = await this.rustHost.status();
    } catch (e: any) {
      this.toastr.error(e?.message || String(e), 'Rust Sequencer');
    }
  }

  async start() {
    try {
      this.loading.isLoading = true;
      const req: CollatorStartRequest = {
        port: this.port,
        wsPath: this.wsPath,
        dataDir: this.dataDir || undefined,
        entryPath: this.entryPath || undefined,
        clearlistEnforce: !!this.clearlistEnforce,
        clearlistUrl: this.clearlistUrl || undefined,
        clearlistFailMode: this.clearlistFailMode,
      };
      this.status = await this.host.start(req);
    } catch (e: any) {
      this.toastr.error(e?.message || String(e), 'Sequencer Start');
    } finally {
      this.loading.isLoading = false;
    }
  }

  async startRust() {
    try {
      this.loading.isLoading = true;
      const req: RustSequencerStartRequest = {
        port: this.rustPort,
        wsPath: this.rustWsPath,
        dataDir: this.rustDataDir || undefined,
        exePath: this.rustExePath || undefined,
        args: this.rustArgs || undefined,
      };
      this.rustStatus = await this.rustHost.start(req);
    } catch (e: any) {
      this.toastr.error(e?.message || String(e), 'Rust Sequencer Start');
    } finally {
      this.loading.isLoading = false;
    }
  }

  async stop() {
    try {
      this.loading.isLoading = true;
      this.status = await this.host.stop();
    } catch (e: any) {
      this.toastr.error(e?.message || String(e), 'Sequencer Stop');
    } finally {
      this.loading.isLoading = false;
    }
  }

  async stopRust() {
    try {
      this.loading.isLoading = true;
      this.rustStatus = await this.rustHost.stop();
    } catch (e: any) {
      this.toastr.error(e?.message || String(e), 'Rust Sequencer Stop');
    } finally {
      this.loading.isLoading = false;
    }
  }

  useAsCollator() {
    const url = this.wsUrl;
    if (!url) return;
    const current = this.p2pSettings.collatorUrls || [];
    const next = [url, ...current.filter((u) => u !== url)];
    this.p2pSettings.setCollatorUrls(next);
    this.toastr.success('Added local sequencer URL to collator list', 'P2P');
  }

  useAsOrderbookServer() {
    const url = this.rustStatus?.wsUrl || (this.rustPort ? `ws://127.0.0.1:${this.rustPort}` : '');
    if (!url) return;
    // Reuse the existing servers dialog; user can pick @custom and paste this URL.
    // This helper just copies into clipboard would be nicer, but keep it minimal for now.
    this.toastr.info(`Rust orderbook endpoint: ${url}`, 'Orderbook');
  }
}
