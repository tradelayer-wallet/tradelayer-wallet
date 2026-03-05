import { Component, OnInit } from '@angular/core';
import { Observable } from 'rxjs';
import { BitvmRuntimeService, BitvmStatus } from 'src/app/@core/services/bitvm-runtime.service';

@Component({
  selector: 'tl-bitvm-page',
  templateUrl: './bitvm-page.component.html',
  styleUrls: ['./bitvm-page.component.scss']
})
export class BitvmPageComponent implements OnInit {
  status$: Observable<BitvmStatus>;
  watchtowerIntervalMs: number = 15000;
  watchtowerAutoFraudProof: boolean = false;

  constructor(private bitvmRuntime: BitvmRuntimeService) {
    this.status$ = this.bitvmRuntime.status$;
  }

  ngOnInit(): void {
    // Hook points for desktop runtime integration (watchtower, challenge feeds, payout finalization).
    this.bitvmRuntime.registerChallengeObservedHook(() => undefined);
    this.bitvmRuntime.registerFraudProofEmitHook(() => undefined);
    this.bitvmRuntime.registerPayoutFinalizedHook(() => undefined);
    this.bitvmRuntime.startWatchtowerLoop();
    this.bitvmRuntime.refresh().catch(() => undefined);
  }

  onToggleFeature(enabled: boolean): void {
    this.bitvmRuntime.setFeatureEnabled(enabled);
  }

  async refresh(): Promise<void> {
    await this.bitvmRuntime.refresh();
  }

  async startWatchtower(): Promise<void> {
    await this.bitvmRuntime.startWatchtower({
      intervalMs: this.watchtowerIntervalMs,
      autoFraudProof: this.watchtowerAutoFraudProof,
    });
    await this.refresh();
  }

  async stopWatchtower(): Promise<void> {
    await this.bitvmRuntime.stopWatchtower();
    await this.refresh();
  }

  async tickWatchtower(): Promise<void> {
    await this.bitvmRuntime.runWatchtowerTick();
  }

  async emitFraudProof(): Promise<void> {
    await this.bitvmRuntime.emitFraudProof();
  }
}
