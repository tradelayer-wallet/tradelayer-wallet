import { Component, OnDestroy, OnInit } from '@angular/core';
import { FormBuilder, Validators } from '@angular/forms';

interface StrategyRow {
  rank: number;
  market: string;    // e.g., 'DOGE/USDT' or 'TL/LTC'
  mode: string;      // 'Futures Grid', 'Spot Grid', etc.
  leverage?: string; // 'Long20x' etc.
  roiPct: number;    // 392.34 means 392.34%
  pnlUsd: number;
  copiers: number;
  runtime: string;   // '516D 18h 19m'
}

// Optional metadata authors can export from their strategy module as `export const meta = { ... }`
// We mirror it here for the UI and mock usage until the upload/runner wiring is done.
export interface StrategyMetaField {
  label: string;            // e.g., "Price Decrease"
  key: string;              // e.g., "priceDecrease"
  value: string | number;   // display-only for now
}
export interface StrategyMeta {
  contract: string;                 // e.g., 'BTCUSDT Long 50x' or 'TL/LTC'
  minInvestment: number;            // **required** minimum
  fields?: StrategyMetaField[];     // optional rows to display
  counterVenue?: {                  // optional cross-venue info
    name: string;                   // e.g., 'Binance Futures'
    needsApiKey: boolean;           // if true, show API key/secret inputs
  };
}

interface RunningInstance {
  id: string;
  name: string;
  market: string;
  allocated: number;       // user initial allocation (wallet denom)
  pnl: number;             // running PnL since start
  startedAt: number;       // epoch ms
  counterVenuePct?: number;// % of capital currently on counter venue
}

@Component({
  selector: 'app-algo-trading',
  templateUrl: './algo-trading.component.html',
  styleUrls: ['./algo-trading.component.scss']
})
export class AlgoTradingComponent implements OnInit, OnDestroy {
  // Added a first tab for user's running systems
  tabs = [
    { key: 'running', label: 'Running Systems' },
    { key: 'fusion', label: 'Fusion Rankings' },
    { key: 'futuresGrid', label: 'Futures Grid' },
    { key: 'futuresMartingale', label: 'Futures Martingale' },
    { key: 'futuresCombo', label: 'Futures Combo' },
    { key: 'spotGrid', label: 'Spot Grid' },
  ];
  activeTab = this.tabs[0].key;

  filters = this.fb.group({
    market: ['All'],
    runningTime: ['All'],
    roi: ['All'],
    category: ['All'],
    sort: ['Recommended']
  });

  rows: StrategyRow[] = [];

  // Running instances in this session (replace with relayer-backed list later)
  running: RunningInstance[] = [];

  // Allocation dialog state
  showAllocate = false;
  showWithdraw = false;
  selectedRow?: StrategyRow;
  selectedMeta?: StrategyMeta;
  withdrawFor?: RunningInstance;

  allocationForm = this.fb.group({
    amount: [null as number | null, [Validators.required, Validators.min(0)]],
    apiKey: [''],
    apiSecret: ['']
  });

  withdrawForm = this.fb.group({
    amount: [null as number | null, [Validators.required, Validators.min(0)]],
  });

  constructor(private fb: FormBuilder) {}

  ngOnInit(): void {
    // TODO: replace with live feed from your relayer (top strategies endpoint)
    this.rows = [
      { rank: 1, market: 'DOGE/USDT', mode: 'Futures Grid', leverage: 'Long20x', roiPct: 392.34, pnlUsd: 392.34, copiers: 29894, runtime: '516D 18h 19m' },
      { rank: 2, market: 'BTC/USDT', mode: 'Futures Grid', leverage: 'Long50x', roiPct: 26.03, pnlUsd: 911.12, copiers: 1923, runtime: '536D 13h 57m' },
      { rank: 3, market: 'BTC ETH LINK +1', mode: 'Futures Combo', leverage: 'Long20x', roiPct: 207.54, pnlUsd: 415.91, copiers: 5, runtime: '19D 22h 41m' },
      { rank: 4, market: 'REQ/USDT', mode: 'Futures Grid', leverage: 'Long5x', roiPct: 235.97, pnlUsd: 589.93, copiers: 3353, runtime: '639D 13h 25m' },
      { rank: 5, market: 'BTC/USDT', mode: 'Spot Grid', roiPct: 45.79, pnlUsd: 847.09, copiers: 2930, runtime: '545D 12h 38m' },
      { rank: 6, market: 'ETH/USDT', mode: 'Futures Grid', leverage: 'Neutral42x', roiPct: 205.46, pnlUsd: 111.9, copiers: 3481, runtime: '502D 10h 41m' },
    ];
  }

  ngOnDestroy(): void {}

  setTab(key: string) { this.activeTab = key; }

  // Upload can attach strategy metadata later; this is a placeholder.
  onUploadFile(input: HTMLInputElement) {
    const file = input.files?.[0];
    if (!file) return;
    alert(`Loaded strategy file: ${file.name}`);
    input.value = '';
  }

  // Opens allocate dialog; loads metadata (mock for now)
  onCopy(row: StrategyRow) {
    this.selectedRow = row;
    // NOTE: In production, load from the uploaded module: mod.meta or mod.default.meta
    // Here we mock something Bybit-like but original.
    this.selectedMeta = {
      contract: `${row.market} ${row.leverage ?? ''}`.trim(),
      minInvestment: 117.3332,
      fields: [
        { label: 'Price Step', key: 'priceStep', value: '0.5%' },
        { label: 'Position Multiplier', key: 'posMult', value: '1.4' },
        { label: 'Max Additions / Round', key: 'addsPerRound', value: 7 },
        { label: 'Profit Target / Round', key: 'profitPerRound', value: '10%' },
        { label: 'Looping', key: 'loop', value: 'Active' },
      ],
      counterVenue: row.mode.includes('Futures') ? { name: 'Binance Futures', needsApiKey: true } : undefined,
    };

    this.allocationForm.reset({ amount: null, apiKey: '', apiSecret: '' });
    this.showAllocate = true;
  }

  closeAllocate() { this.showAllocate = false; }

  allocateConfirm() {
    if (!this.selectedMeta) return;
    const amt = Number(this.allocationForm.value.amount ?? 0);
    if (amt < this.selectedMeta.minInvestment) {
      alert(`Minimum size is ${this.selectedMeta.minInvestment}`);
      return;
    }

    // Handle optional cross-venue creds
    if (this.selectedMeta.counterVenue?.needsApiKey) {
      const key = (this.allocationForm.value.apiKey || '').toString().trim();
      const secret = (this.allocationForm.value.apiSecret || '').toString().trim();
      if (!key || !secret) { alert('API key & secret required for counter venue.'); return; }
      this.persistVenueCreds(this.selectedMeta.counterVenue.name, key, secret);
    }

    // Create a running instance entry
    const inst: RunningInstance = {
      id: Math.random().toString(36).slice(2),
      name: this.selectedMeta.contract,
      market: this.selectedRow?.market ?? 'Unknown',
      allocated: amt,
      pnl: 0,
      startedAt: Date.now(),
      counterVenuePct: this.selectedMeta.counterVenue ? 50 : 0, // stub; replace with relayer metric
    };
    this.running.unshift(inst);
    this.showAllocate = false;
    this.activeTab = 'running';
  }

  persistVenueCreds(venue: string, apiKey: string, apiSecret: string) {
    // Desktop: call into a bridge that writes to .env (Electron preload / native IPC)
    // Web: POST to your relayer to store server-side (or encrypt in storage).
    // Placeholder implementation:
    console.log('Saving creds for', venue, { apiKey: apiKey.slice(0, 4) + '…', apiSecret: apiSecret.slice(0, 4) + '…' });
    // TODO wire: window.tl?.writeEnv(venue, apiKey, apiSecret) OR http POST to /api/venues/creds
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
    // TODO: call cancel/withdraw on relayer; update PnL/allocated.
    this.withdrawFor.allocated = Math.max(0, this.withdrawFor.allocated - amt);
    this.showWithdraw = false;
  }
}