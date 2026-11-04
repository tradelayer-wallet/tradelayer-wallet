import {
  Component,
  ElementRef,
  EventEmitter,
  Input,
  NgZone,
  OnChanges,
  OnDestroy,
  Output,
  SimpleChanges,
  ViewChild,
} from '@angular/core';
import { ChartKind, InstrumentPlan, planInstrument } from './bitcorn-instrument';

export interface IBitcornSource {
  venue: string;
  kind: string;
  instrument: string | null;
}

export type BitcornState = 'connecting' | 'live' | 'demo' | 'stale' | 'unavailable' | 'disrupted' | 'stopped';

// BitcornWisdom's SDK (bundled at build time under ./bitcorn/, see ui-overlay/fe-speed-skin) is an
// ES module that mounts a sandboxed same-origin iframe and talks to it with exact-origin postMessage.
// The wallet never loads it from the network; webpackIgnore keeps the import native.
let sdkPromise: Promise<any> | null = null;
function loadSdk(): Promise<any> {
  if (!sdkPromise) {
    const url = new URL('bitcorn/src/embed-sdk.js', document.baseURI).href;
    sdkPromise = import(/* webpackIgnore: true */ url).catch((err) => {
      sdkPromise = null;
      throw err;
    });
  }
  return sdkPromise;
}

const INTERVALS = ['1m', '5m', '15m', '1h', '1d'];

@Component({
  selector: 'tl-bitcorn-chart',
  templateUrl: './bitcorn-chart.component.html',
  styleUrls: ['./bitcorn-chart.component.scss'],
})
export class BitcornChartComponent implements OnChanges, OnDestroy {
  @ViewChild('host', { static: true }) hostRef!: ElementRef<HTMLElement>;

  @Input() kind: ChartKind = 'spot';
  @Input() base = '';
  @Input() quote = '';

  @Output() planChange = new EventEmitter<InstrumentPlan>();
  @Output() sourceChange = new EventEmitter<IBitcornSource | null>();
  @Output() stateChange = new EventEmitter<BitcornState>();

  plan: InstrumentPlan = planInstrument({ kind: 'spot', base: '', quote: '' });
  loadError = '';
  /** the perpetual had no reachable source and the spot fallback is shown */
  usingFallback = false;

  private widget: any = null;
  private mountedInstrument: string | null = null;
  private generation = 0;
  private destroyed = false;
  private unsubscribers: Array<() => void> = [];

  constructor(private zone: NgZone) {}

  get note(): string {
    if (this.usingFallback) {
      const spot = (this.plan.fallback || '').replace('-SPOT', '').replace('-', ' / ');
      return `The ${this.plan.label} feed is unreachable; showing ${spot} spot.`;
    }
    return this.plan.note;
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (!changes.kind && !changes.base && !changes.quote) return;
    this.usingFallback = false;
    this.apply(planInstrument({ kind: this.kind, base: this.base, quote: this.quote }));
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.generation++;
    this.teardown();
  }

  private apply(plan: InstrumentPlan): void {
    this.plan = plan;
    // the parent card binds these events to its header; emit after the current change detection pass
    Promise.resolve().then(() => { if (!this.destroyed) this.planChange.emit(plan); });
    if (plan.state === 'none' || !plan.instrument) {
      this.teardown();
      Promise.resolve().then(() => {
        if (this.destroyed) return;
        this.sourceChange.emit(null);
        this.stateChange.emit('stopped');
      });
      return;
    }
    this.show(plan.instrument);
  }

  private show(instrument: string): void {
    if (instrument === this.mountedInstrument && this.widget) return;
    const generation = ++this.generation;
    this.loadError = '';
    loadSdk().then(
      (sdk) => {
        if (this.destroyed || generation !== this.generation) return;
        if (this.widget) {
          // same iframe, new market: the SDK resets the candle history under the new venue's identity
          const current = this.widget.getState()?.interval;
          this.mountedInstrument = instrument;
          this.widget.setMarket(instrument, INTERVALS.includes(current) ? current : '1m');
          this.sourceChange.emit(null);
          return;
        }
        this.mountedInstrument = instrument;
        // the SDK's own timers and message handlers run outside Angular; only the events below re-enter
        this.widget = this.zone.runOutsideAngular(() =>
          sdk.mountBitcornChart(this.hostRef.nativeElement, {
            instrument,
            interval: '1m',
            theme: 'chrome',
            height: '100%',
            title: 'Live market chart (BitcornWisdom)',
          }));
        this.listen(this.widget);
      },
      (err) => {
        if (this.destroyed || generation !== this.generation) return;
        this.loadError = `Chart module could not be loaded: ${err?.message || err}`;
      },
    );
  }

  private listen(widget: any): void {
    const on = (event: string, fn: (payload: any) => void) =>
      this.unsubscribers.push(widget.on(event, (payload: any) => this.zone.run(() => fn(payload))));
    on('source', ({ source }) => {
      this.sourceChange.emit(source ? { venue: source.venue, kind: source.kind, instrument: source.instrument || null } : null);
    });
    on('status', ({ state }) => {
      this.stateChange.emit(state);
      // a perpetual that no source can serve falls back to the spot chart of the same asset
      if (state === 'unavailable' && this.plan.fallback && !this.usingFallback && this.mountedInstrument !== this.plan.fallback) {
        this.usingFallback = true;
        this.mountedInstrument = this.plan.fallback;
        widget.setMarket(this.plan.fallback, '1m');
      }
    });
    on('error', ({ message }) => {
      this.loadError = message || 'The chart reported an error.';
    });
    widget.ready.then(() => { this.loadError = ''; }, () => {
      if (!this.destroyed) this.zone.run(() => { this.loadError = 'The chart did not complete its handshake.'; });
    });
  }

  private teardown(): void {
    for (const off of this.unsubscribers.splice(0)) {
      try { off(); } catch { /* handler set already cleared */ }
    }
    if (this.widget) {
      try { this.widget.destroy(); } catch { /* already destroyed */ }
      this.widget = null;
    }
    this.mountedInstrument = null;
  }
}
