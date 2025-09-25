import { Component, OnDestroy, OnInit } from '@angular/core';
import { FormBuilder, FormGroup, Validators } from '@angular/forms';
import { MatDialog } from '@angular/material/dialog';
import { Subscription } from 'rxjs';

import { AlgoTradingService, DiscoveryRow, RunningSystem } from './algo-trading-service';
import { UploadSystemDialogComponent } from './upload-system-dialog.component';

@Component({
  selector: 'tl-algo-trading',
  templateUrl: './algo-trading.component.html',
  styleUrls: ['./algo-trading.component.css']
})
export class AlgoTradingComponent implements OnInit, OnDestroy {
  tabs = [
    { key: 'running', label: 'Running' },
    { key: 'discover', label: 'Discover' },
  ];
  activeTab: 'running' | 'discover' = 'discover';

  // discovery
  filters: FormGroup;
  rows: DiscoveryRow[] = [];

  // running
  running: RunningSystem[] = [];

  // allocate dialog state
  showAllocate = false;
  allocationForm: FormGroup;
  selectedMeta: any | null = null;

  // withdraw dialog state
  showWithdraw = false;
  withdrawForm: FormGroup;
  withdrawFor?: RunningSystem;

  private sub = new Subscription();

  constructor(
    private fb: FormBuilder,
    private svc: AlgoTradingService,
    private dialog: MatDialog
  ) {
    this.filters = this.fb.group({
      market: ['All'],
      runningTime: ['All'],
      roi: ['All'],
      category: ['All'],
      sort: ['Recommended']
    });

    this.allocationForm = this.fb.group({
      amount: [null, [Validators.required, Validators.min(0.0001)]],
      apiKey: [''],
      apiSecret: ['']
    });

    this.withdrawForm = this.fb.group({
      amount: [null, [Validators.required, Validators.min(0.0001)]]
    });
  }

  ngOnInit(): void {
    this.sub.add(this.svc.discovery$.subscribe(rows => this.rows = rows));
    this.sub.add(this.svc.running$.subscribe(list => this.running = list));
    this.refreshDiscovery();
    this.refreshRunning();

    // auto-refresh on filter change
    this.sub.add(this.filters.valueChanges.subscribe(() => this.refreshDiscovery()));
  }

  ngOnDestroy(): void {
    this.sub.unsubscribe();
  }

  setTab(key: 'running' | 'discover') {
    this.activeTab = key;
    if (key === 'running') this.refreshRunning();
  }

  refreshDiscovery() {
    const f = this.filters.value;
    const params = {
      market: f.market,
      runningTime: f.runningTime,
      roi: f.roi,
      category: f.category,
      sort: f.sort
    };
    this.svc.fetchDiscovery(params).subscribe();
  }

  refreshRunning() {
    this.svc.fetchRunning().subscribe();
  }

  openUploadSystemDialog() {
    const ref = this.dialog.open(UploadSystemDialogComponent, {
      width: '520px',
      disableClose: true
    });
    ref.afterClosed().subscribe((res) => {
      if (res?.ok) {
        // Optionally, show a toast. Then refresh discovery.
        this.refreshDiscovery();
      }
    });
  }

  onCopy(row: DiscoveryRow) {
    // minimal meta for the Allocate dialog
    this.selectedMeta = {
      contract: row.market,
      minInvestment: 10,
      fields: [
        { label: 'Mode', value: row.mode + (row.leverage ? ' ' + row.leverage : '') },
        { label: 'ROI (30d)', value: (row.roiPct ?? 0).toFixed(2) + '%' },
      ],
      counterVenue: { name: 'In-house MM', needsApiKey: false }
    };
    this.allocationForm.reset({ amount: null, apiKey: '', apiSecret: '' });
    (this as any).__pendingSystemId = row.id;
    this.showAllocate = true;
  }

  closeAllocate() {
    this.showAllocate = false;
    this.selectedMeta = null;
  }

  allocateConfirm() {
    const amount = Number(this.allocationForm.value.amount);
    if (!amount || amount <= 0) return;
    const systemId = (this as any).__pendingSystemId as string;
    const apiKey = this.allocationForm.value.apiKey || undefined;
    const apiSecret = this.allocationForm.value.apiSecret || undefined;
    this.svc.allocate({
      systemId,
      amount,
      counterVenue: apiKey || apiSecret ? { name: 'Counter Venue', apiKey, apiSecret } : undefined
    }).subscribe(() => {
      this.closeAllocate();
      this.setTab('running');
    });
  }

  openWithdraw(s: RunningSystem) {
    this.withdrawFor = s;
    this.withdrawForm.reset({ amount: null });
    this.showWithdraw = true;
  }
  closeWithdraw() {
    this.showWithdraw = false;
    this.withdrawFor = undefined;
  }
  confirmWithdraw() {
    const amount = Number(this.withdrawForm.value.amount);
    if (!amount || !this.withdrawFor) return;
    this.svc.withdraw(this.withdrawFor.runId, amount).subscribe(() => {
      this.closeWithdraw();
    });
  }
}
