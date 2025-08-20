import { Component, OnInit, OnDestroy } from '@angular/core';
import { FormBuilder, FormGroup } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { MatDialog } from '@angular/material/dialog';
import { Observable } from 'rxjs';
import {
  UploadSystemDialogComponent,
  UploadSystemDialogResult
} from '../../@shared/dialogs/upload-system-dialog/upload-system-dialog.component';


interface StrategyRow {
  rank: number;
  market: string;
  mode: string;
  leverage?: string;
  roiPct: number;
  pnlUsd: number;
  copiers: number;
  runtime: string;
}

interface RunningInstance {
  id: string;
  name: string;
  market: string;
  allocated: number;
  communityScore: number;
  counterVenuePct: number;
}

interface SelectedMeta {
  contract: string;
  minInvestment: number;
  feesBps: number;
  contractMultiplier?: number;
  counterVenue?: { name: string; needsApiKey: boolean };
}

@Component({
  selector: 'app-algo-trading-page',
  templateUrl: './algo-trading.component.html',
  styleUrls: ['./algo-trading.component.scss']
})
export class AlgoTradingPageComponent implements OnInit, OnDestroy {
  activeTab: 'discover' | 'running' = 'discover';

  rows: StrategyRow[] = [];
  selectedRow?: StrategyRow;
  selectedMeta?: SelectedMeta;

  allocationForm: FormGroup;
  showAllocate = false;

  running: RunningInstance[] = [];

  withdrawForm: FormGroup;
  withdrawFor?: RunningInstance;
  showWithdraw = false;

  constructor(
    private fb: FormBuilder,
    private dialog: MatDialog,
    private http: HttpClient
  ) {
    this.allocationForm = this.fb.group({
      amount: [],
      apiKey: [''],
      apiSecret: ['']
    });

    this.withdrawForm = this.fb.group({
      amount: []
    });
  }

  ngOnInit(): void {
    // TODO: swap with relayer "top strategies" endpoint
    this.rows = [
      { rank: 1, market: 'DOGE/USDT', mode: 'Futures Grid', leverage: 'Long20x', roiPct: 392.34, pnlUsd: 392.34, copiers: 29894, runtime: '516D 18h 19m' },
      { rank: 2, market: 'BTC/USDT', mode: 'Futures Grid', leverage: 'Long50x', roiPct: 26.03, pnlUsd: 911.12, copiers: 1923, runtime: '536D 13h 57m' },
      { rank: 3, market: 'BTC ETH LINK +1', mode: 'Futures Combo', leverage: 'Long20x', roiPct: 207.54, pnlUsd: 415.91, copiers: 5, runtime: '19D 22h 41m' },
    ];
  }

  ngOnDestroy(): void {}

  // in algo-trading.component.ts (inside the class)
tabs = [
  { key: 'discover', label: 'Discover' },
  { key: 'running',  label: 'Running'  },
];

// inside class
private newId(): string {
  return 'sys_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}


  setTab(key: 'discover' | 'running') { this.activeTab = key; }

  onUploadFile(input: HTMLInputElement) {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    // default to non-public for quick local run
    this.handleSystemUpload({ file, isPublic: false });
  }

  onCopy(row: StrategyRow) {
    this.selectedRow = row;
    this.selectedMeta = {
      contract: `${row.market} ${row.leverage ?? ''}`.trim(),
      minInvestment: 50,
      feesBps: 12,
      contractMultiplier: 1,
      counterVenue: row.mode.includes('Futures') ? { name: 'Binance Futures', needsApiKey: true } : undefined
    };
    this.allocationForm.reset({ amount: null, apiKey: '', apiSecret: '' });
    this.showAllocate = true;
  }

  closeAllocate() { this.showAllocate = false; }

  allocateConfirm() {
    if (!this.selectedMeta) return;
    const amt = Number(this.allocationForm.value.amount ?? 0);
    if (isNaN(amt) || amt <= 0) return;

    if (amt < this.selectedMeta.minInvestment) {
      alert(`Minimum size is ${this.selectedMeta.minInvestment}`);
      return;
    }

    if (this.selectedMeta.counterVenue?.needsApiKey) {
      const key = (this.allocationForm.value.apiKey || '').toString().trim();
      const secret = (this.allocationForm.value.apiSecret || '').toString().trim();
      if (!key || !secret) {
        alert('API key/secret required for counter venue');
        return;
      }
      this.persistVenueCreds(this.selectedMeta.counterVenue.name, key, secret);
    }

    const inst: RunningInstance = {
      id: this.newId(),
      name: this.selectedMeta.contract,
      market: this.selectedRow?.market ?? 'Unknown',
      allocated: amt,
      communityScore: 0, // stub; replace with relayer metric
      counterVenuePct: this.selectedMeta.counterVenue ? 50 : 0, // stub
    };

    this.running.unshift(inst);
    this.showAllocate = false;
    this.activeTab = 'running';
  }

  persistVenueCreds(venue: string, apiKey: string, apiSecret: string) {
    // TODO: replace with secure storage flow
    console.log('Saving creds for', venue, {
      apiKey: apiKey.slice(0, 4) + '…',
      apiSecret: apiSecret.slice(0, 4) + '…'
    });
  }

  openWithdraw(inst: RunningInstance) {
    this.withdrawFor = inst;
    this.withdrawForm.reset({ amount: null });
    this.showWithdraw = true;
  }
  closeWithdraw() { this.showWithdraw = false; }
  confirmWithdraw() {
    const amt = Number(this.withdrawForm.value.amount ?? 0);
    if (!this.withdrawFor || isNaN(amt) || amt <= 0) return;
    this.withdrawFor.allocated = Math.max(0, this.withdrawFor.allocated - amt);
    this.showWithdraw = false;
  }

  openUploadSystemDialog() {
    const ref = this.dialog.open(UploadSystemDialogComponent, { width: '420px' });
    ref.afterClosed().subscribe((result?: UploadSystemDialogResult) => {
      if (result?.file) this.handleSystemUpload(result);
    });
  }

  private handleSystemUpload(result: UploadSystemDialogResult) {
    this.uploadSystem(result.file, { isPublic: !!result.isPublic, name: result.name })
      .subscribe({
        next: () => alert('Uploaded system successfully'),
        error: (err) => {
          console.error(err);
          alert('Upload failed');
        }
      });
  }

  uploadSystem(file: File, opts: { isPublic: boolean; name?: string }): Observable<void> {
    const form = new FormData();
    form.append('file', file);
    form.append('isPublic', String(opts.isPublic));
    if (opts.name) form.append('name', opts.name);
    return this.http.post<void>('/api/systems/upload', form);
  }
}
