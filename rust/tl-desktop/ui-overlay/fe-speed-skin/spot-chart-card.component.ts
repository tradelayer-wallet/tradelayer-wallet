import { Component } from '@angular/core';

import { SpotMarketsService } from 'src/app/@core/services/spot-services/spot-markets.service';
import { BitcornState, IBitcornSource } from 'src/app/@pages/bitcorn-chart/bitcorn-chart.component';
import { InstrumentPlan } from 'src/app/@pages/bitcorn-chart/bitcorn-instrument';

// Chart card of the spot screen: BitcornWisdom's embedded chart fed by the exchanges' public
// WebSocket feeds (ui-overlay/fe-speed-skin). The TradeLayer market is mapped to a venue
// instrument by bitcorn-instrument.ts; the chart follows market changes.
@Component({
  selector: 'tl-spot-chart-card',
  templateUrl: './spot-chart-card.component.html',
  styleUrls: ['./spot-chart-card.component.scss'],
})
export class SpotChartCardComponent {
  readonly kind = 'spot';
  plan: InstrumentPlan | null = null;
  source: IBitcornSource | null = null;
  state: BitcornState = 'connecting';

  constructor(private spotMarketsService: SpotMarketsService) {}

  get base(): string {
    return this.spotMarketsService.selectedMarket?.first_token?.shortName || '';
  }

  get quote(): string {
    return this.spotMarketsService.selectedMarket?.second_token?.shortName || '';
  }

  get venue(): string {
    return this.source?.kind === 'relay' ? 'RELAY' : (this.source?.venue || '').toUpperCase();
  }
}
