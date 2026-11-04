import { Component } from '@angular/core';

import { FuturesMarketService } from 'src/app/@core/services/futures-services/futures-markets.service';
import { BitcornState, IBitcornSource } from 'src/app/@pages/bitcorn-chart/bitcorn-chart.component';
import { InstrumentPlan } from 'src/app/@pages/bitcorn-chart/bitcorn-instrument';

// Chart card of the futures screen: the same BitcornWisdom chart as the spot card, for the selected
// contract. BTC and LTC contracts map to the Binance USDT perpetual (spot fallback), TL contracts to
// their collateral asset or the "no external market" state.
@Component({
  selector: 'tl-futures-chart-card',
  templateUrl: '../../../spot-page/spot-trading-grid/spot-chart-card/spot-chart-card.component.html',
  styleUrls: ['../../../spot-page/spot-trading-grid/spot-chart-card/spot-chart-card.component.scss'],
})
export class FuturesChartCardComponent {
  readonly kind = 'futures';
  plan: InstrumentPlan | null = null;
  source: IBitcornSource | null = null;
  state: BitcornState = 'connecting';

  constructor(private futuresMarketService: FuturesMarketService) {}

  get base(): string {
    const m: any = this.futuresMarketService.selectedMarket;
    return m?.first_token?.shortName || String(m?.contractName || m?.pairString || '').split('/')[0] || '';
  }

  get quote(): string {
    const m: any = this.futuresMarketService.selectedMarket;
    return m?.second_token?.shortName || String(m?.contractName || m?.pairString || '').split('/')[1] || '';
  }

  get venue(): string {
    return this.source?.kind === 'relay' ? 'RELAY' : (this.source?.venue || '').toUpperCase();
  }
}
