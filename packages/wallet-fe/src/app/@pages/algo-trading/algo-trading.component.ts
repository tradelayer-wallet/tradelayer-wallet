// ...existing imports...
import { Component, OnDestroy, OnInit } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { Subscription } from 'rxjs';
import {
  AlgoTradingService,
  DiscoveryRow,
  RunningSystem
} from '../../@core/services/algo-trading.service';
import { UploadSystemDialogComponent } from '../../@shared/dialogs/upload-system-dialog/upload-system-dialog.component';

@Component({
  selector: 'tl-algo-trading-page',
  templateUrl: './algo-trading.component.html',
  styleUrls: ['./algo-trading.component.scss'],
})
export class AlgoTradingPageComponent implements OnInit, OnDestroy {
  // ✨ template expects these:
  tabs = [
    { key: 'running', label: 'Running' },
    { key: 'discover', label: 'Discover' },
    { key: 'my-systems', label: 'My Systems' },
  ];
  activeTab: 'running' | 'discover' | 'my-systems' = 'running';

  showAllocate = false;
  showWithdraw = false;

  rows: DiscoveryRow[] = [];
  running: RunningSystem[] = [];
  loading = false;

  private sub = new Subscription();

  constructor(
    private dialog: MatDialog,
    private svc: AlgoTradingService
  ) {}

   ngOnInit(): void {
    console.log('[algo-ui] init → fetch discovery & running');

    // Use simple subscribe(next, error) to avoid the 'unknown' observer overload
    this.svc.fetchDiscovery({})
      .pipe(take(1))
      .subscribe(
        (rows: DiscoveryRow[]) =>
          console.log('[algo-ui] discovery rows', rows?.length ?? 0),
        (e: any) =>
          console.error('[algo-ui] discovery error', e),
      );

    this.svc.fetchRunning()
      .pipe(take(1))
      .subscribe(
        (rows: RunningSystem[]) =>
          console.log('[algo-ui] running rows', rows?.length ?? 0),
        (e: any) =>
          console.error('[algo-ui] running error', e),
      );
  }

  onFiltersChanged(): void {
    const f = this.filters.value;
    this.svc.fetchDiscovery(f).pipe(take(1)).subscribe();
  }

  ngOnDestroy(): void {
    this.sub.unsubscribe();
  }

  // used by template button
  setTab(key: 'running'|'discover'|'my-systems') {
    this.activeTab = key;
  }

  // The HTML calls openUploadSystemDialog(); keep this alias:
  openUploadSystemDialog(): void {
    this.openUploadDialog();
  }

  // actual dialog opener (also used by alias above)
  openUploadDialog(): void {
    const ref = this.dialog.open(UploadSystemDialogComponent, {
      width: '520px',
      disableClose: true,
    });
    this.sub.add(ref.afterClosed().subscribe(() => {}));
  }

  // simple local dialog toggles; wire to real flows later
  openAllocate() { this.showAllocate = true; }
  closeAllocate() { this.showAllocate = false; }

  openWithdraw() { this.showWithdraw = true; }
  closeWithdraw() { this.showWithdraw = false; }
}
