import { Component, OnDestroy, OnInit } from '@angular/core';
import { FormBuilder } from '@angular/forms';

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

@Component({
  selector: 'app-algo-trading',
  templateUrl: './algo-trading.component.html',
  styleUrls: ['./algo-trading.component.scss']
})
export class AlgoTradingComponent implements OnInit, OnDestroy {
  tabs = [
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

  onCopy(row: StrategyRow) {
    // For now this is a placeholder. Later: open drawer -> show strategy details -> "Copy" or "Run" -> prefill config
    alert(`Copy/Run template for ${row.market} coming soon`);
  }

  onUploadFile(input: HTMLInputElement) {
    const file = input.files?.[0];
    if (!file) return;
    // In desktop: forward to child-process runner. In web: load into Worker. Here we just show name.
    alert(`Loaded strategy file: ${file.name}`);
    input.value = '';
  }
}