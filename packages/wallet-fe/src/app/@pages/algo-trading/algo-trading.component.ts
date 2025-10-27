import { Component, OnInit, ChangeDetectionStrategy, OnDestroy } from '@angular/core';
import { FormBuilder, FormGroup, Validators } from '@angular/forms';
import { Subscription, of } from 'rxjs';
import { debounceTime, distinctUntilChanged, take, map, switchMap } from 'rxjs/operators';
import { ChangeDetectorRef, NgZone } from '@angular/core';

import {
  AlgoTradingService,
  DiscoveryRow,
  RunningSystem,
} from '../../@core/services/algo-trading.service';

import { MatDialog } from '@angular/material/dialog';
import { ToastrService } from 'ngx-toastr';
import { UploadSystemDialogComponent } from '../../@shared/dialogs/upload-system-dialog/upload-system-dialog.component';

type TabKey = 'discovery' | 'running';

@Component({
  selector: 'tl-algo-trading-page',
  templateUrl: './algo-trading.component.html',
  styleUrls: ['./algo-trading.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})

export class AlgoTradingPageComponent implements OnInit, OnDestroy {
  // ---------- Tabs used in the template ----------
  tabs = [
    { key: 'discovery' as TabKey, label: 'Discovery' },
    { key: 'running' as TabKey, label: 'Running' },
  ];
  activeTab: TabKey = 'discovery';

  // ---------- Filters form (names match the template) ----------
  filters: FormGroup = this.fb.group({
    market: ['All'],
    runningTime: ['All'],
    roi: ['All'],
    category: ['All'],
    // NOTE: template uses 'sort' (not 'rankBy')
    sort: ['Recommended'],
  });

  // ---------- Data the template reads directly ----------
  rows: DiscoveryRow[] = [];           // used by *ngFor="let r of rows"
  running: RunningSystem[] = [];       // used by *ngFor="let s of running"

  // ---------- Allocate dialog state (template-driven) ----------
  showAllocate = false;
  selectedMeta: any = null;
  selectedSystemId: string | null = null;
  allocationForm: FormGroup = this.fb.group({
    amount: [null, [Validators.required, Validators.min(0)]],
    apiKey: [''],
    apiSecret: [''],
  });

  // ---------- Withdraw dialog state (template-driven) ----------
  showWithdraw = false;
  withdrawFor: RunningSystem | null = null;
  withdrawForm: FormGroup = this.fb.group({
    amount: [null, [Validators.required, Validators.min(0)]],
  });

  private subs = new Subscription();

  constructor(
    private fb: FormBuilder,
    private svc: AlgoTradingService,
    private dialog: MatDialog,
    private toast: ToastrService,
    private cdr: ChangeDetectorRef, private zone: NgZone,
  ) {}

  // ------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------
  ngOnInit(): void {
    // Keep local arrays in sync with the service streams
    this.subs.add(
      this.svc.discovery$.subscribe((rows) => { this.rows = rows || []; })
    );
    this.subs.add(
      this.svc.running$.subscribe((list) => { this.running = list || []; })
    );

    // Initial loads
    this.svc.fetchDiscovery(this.filters.value).pipe(take(1)).subscribe({
      error: (e) => console.error('[algo-ui] discovery load error', e),
    });
    this.svc.fetchRunning().pipe(take(1)).subscribe({
      error: (e) => console.error('[algo-ui] running load error', e),
    });

    // Auto-refetch discovery when filters change
    this.subs.add(
      this.filters.valueChanges
        .pipe(debounceTime(150), distinctUntilChanged((a, b) => JSON.stringify(a) === JSON.stringify(b)))
        .subscribe(() => {
          this.svc.fetchDiscovery(this.filters.value).pipe(take(1)).subscribe();
        })
    );
  }

  ngOnDestroy(): void {
    this.subs.unsubscribe();
  }

  // ------------------------------------------------------------
  // Tabs
  // ------------------------------------------------------------
  setTab(key: TabKey): void {
    this.activeTab = key;
    if (key === 'running') {
      this.svc.fetchRunning().pipe(take(1)).subscribe();
    } else {
      this.svc.fetchDiscovery(this.filters.value).pipe(take(1)).subscribe();
    }
  }

  // ------------------------------------------------------------
  // Upload dialog (matches template's (click)="openUploadSystemDialog()")
  // ------------------------------------------------------------
  openUploadSystemDialog(): void {
    const ref = this.dialog.open(UploadSystemDialogComponent, {
      width: '520px',
      autoFocus: false,
      restoreFocus: false,
      data: {},
    });

    this.subs.add(
      ref.afterClosed().pipe(take(1)).subscribe((ok: boolean) => {
        if (ok) {
          this.toast.success('System uploaded');
          // refresh views
          this.svc.fetchDiscovery(this.filters.value).pipe(take(1)).subscribe();
          this.svc.fetchRunning().pipe(take(1)).subscribe();
        }
      })
    );
  }

  // ------------------------------------------------------------
  // Allocate flow
  // ------------------------------------------------------------
  stopSystem(runId: string): void {
  console.log('runId '+runId)
  if (!runId) return;
  this.svc.stopSystem(runId).pipe(take(1)).subscribe({
    next: () => {
      this.running = (this.running || []).filter(r => r.id !== runId);
      console.log('this.running '+JSON.stringify(this.running))
      this.toast.success('System stopped');
       this.cdr.markForCheck();  
      this.svc.fetchRunning().pipe(take(1)).subscribe();
    },
    error: (e: any) => {
      console.error('[algo-ui] stopSystem error', e);
      this.toast.error('Failed to stop system');
    },
  });
}

  onCopy(row: DiscoveryRow): void {
    // Open the allocate dialog populated with meta from the clicked row
    this.selectedMeta = row?.meta ?? null;
    this.selectedSystemId = row?.id ?? null;
    this.allocationForm.reset({ amount: null, apiKey: '', apiSecret: '' });
    this.showAllocate = true;
  }

  closeAllocate(): void {
    this.showAllocate = false;
    this.selectedMeta = null;
    this.selectedSystemId = null;
  }

  allocateConfirm(): void {
  if (!this.selectedSystemId) return;
  if (this.allocationForm.invalid) {
    this.allocationForm.markAllAsTouched();
    return;
  }

  const { amount, apiKey, apiSecret } = this.allocationForm.value;
  const systemId = this.selectedSystemId!;
  const amountNum = Number(amount) || 0;

  // helper: refresh + toast + close modal
  const finishOk = (msg: string) => {
    this.toast.success(msg);
    this.closeAllocate();
    this.svc.fetchRunning().pipe(take(1)).subscribe();
  };

  // helper: do allocation (top-up / first funding)
  const doAllocate = () => {
      this.svc
        .allocate(systemId, amountNum, {
          counterVenue: { name: 'default', apiKey, apiSecret },
        })
        .pipe(take(1))
        .subscribe({
          next: () => {
            finishOk('Allocation updated');
          },
          error: (e: any) => {
            console.error('[algo-ui] allocate error', e);
            this.toast.error('Failed to allocate');
            // still close modal because bot is already running
            this.closeAllocate();
          },
        });
    };

    // is it already running?
    const list = this.svc.running$.value || [];
    const isRunning = list.some(
      (r) => r.name === systemId || r.runId === systemId || (r as any).systemId === systemId
    );

    if (isRunning) {
      // already live -> just allocate and then close
      doAllocate();
      return;
    }

    // not running -> start, then allocate (if any), then close
    try {
      this.svc
        .runSystem(systemId)
        .pipe(take(1))
        .subscribe({
          next: () => {
            if (amountNum > 0) {
              // fund it, modal closes in doAllocate()
              doAllocate();
            } else {
              // no allocation requested, close immediately
              finishOk('System started');
            }
          },
          error: (e: any) => {
            console.error('[algo-ui] runSystem error', e);
            this.toast.error('Failed to start system');
            // leave modal open so user can retry / change amount
          },
        });
    } catch (e: any) {
      console.error('[algo-ui] runSystem precondition failed', e);
      this.toast.error('Connect a wallet first');
      // leave modal so they see why
    }
  }



  // ------------------------------------------------------------
  // Withdraw flow
  // ------------------------------------------------------------
  openWithdraw(s: RunningSystem): void {
    this.withdrawFor = s || null;
    this.withdrawForm.reset({ amount: null });
    this.showWithdraw = true;
  }

  closeWithdraw(): void {
    this.showWithdraw = false;
    this.withdrawFor = null;
  }

  confirmWithdraw(): void {
    if (!this.withdrawFor) return;
    if (this.withdrawForm.invalid) {
      this.withdrawForm.markAllAsTouched();
      return;
    }
    const { amount } = this.withdrawForm.value;

    // RunningSystem has runId; if your API expects systemId, adapt here
    const systemId = (this.withdrawFor as any).id ?? '';
    if (!systemId) {
      this.toast.error('Missing system identifier');
      return;
    }

    this.svc.withdraw(systemId, Number(amount))
      .pipe(take(1))
      .subscribe({
        next: () => {
          this.toast.success('Withdrawn');
          this.closeWithdraw();
          this.svc.fetchRunning().pipe(take(1)).subscribe();
        },
        error: (e) => {
          console.error('[algo-ui] withdraw error', e);
          this.toast.error('Failed to withdraw');
        },
      });
  }
}
