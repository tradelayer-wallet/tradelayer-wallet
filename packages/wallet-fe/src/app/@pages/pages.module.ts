import { NgModule } from '@angular/core';

import { CommonModule } from '@angular/common';
import { FormsModule, ReactiveFormsModule } from '@angular/forms';

import { MatTabsModule } from '@angular/material/tabs';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatTableModule } from '@angular/material/table';
import { MatCardModule } from '@angular/material/card';
import { MatGridListModule } from '@angular/material/grid-list';
import { MatIconModule } from '@angular/material/icon'; 
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip'; 

import { LoginPageComponent } from './login-page/login-page.component';
import { PortfolioPageComponent } from './portfolio-page/portfolio-page.component';

// import { SpotPageComponent } from './spot-page/spot-page.component';
// import { FuturesPageComponent } from './futures-page/futures-page.component';

// import { SpotMarketsToolbarComponent } from './spot-page/spot-markets-toolbar/spot-markets-toolbar.component'; 
// import { SpotTradingGridComponent } from './spot-page/spot-trading-grid/spot-trading-grid.component';
// import { SpotBuySellCardComponent } from './spot-page/spot-trading-grid/spot-buy-sell-card/spot-buy-sell-card.component';
// import { SpotOrderbookCardComponent } from './spot-page/spot-trading-grid/spot-orderbook-card/spot-orderbook-card.component';
// import { SpotBottomCardComponent } from './spot-page/spot-trading-grid/spot-bottom-card/spot-bottom-card.component';
// import { SpotPendingTxsComponent } from './spot-page/spot-trading-grid/spot-bottom-card/spot-pending-txs/spot-pending-txs.component';
// import { SpotPositionsComponent } from './spot-page/spot-trading-grid/spot-bottom-card/spot-positions/spot-positions.component';
// import { SportHistoryCardComponent } from './spot-page/spot-trading-grid/spot-history-card/spot-history-card.component';
// import { SportChartCardComponent } from './spot-page/spot-trading-grid/spot-chart-card/spot-chart-card.component';

// import { FuturesMarketsToolbarComponent } from './futures-page/futures-markets-toolbar/futurues-markets-toolbar.component';
// import { FuturesTradingGridComponent } from './futures-page/futures-trading-grid/futures-trading-grid.component';
// import { FuturesOrderbookCardComponent } from './futures-page/futures-trading-grid/futures-orderbook-card/futures-orderbook-card.component';
// import { FuturesBuySellCardComponent } from './futures-page/futures-trading-grid/futures-buy-sell-card/futures-buy-sell-card.component';
// import { FuturesHistoryCardComponent } from './futures-page/futures-trading-grid/futures-history-card/futures-history-card.component';

// import { SettingsPageComponent } from './settings-page/settings-page.component';
// import { MultisigPageComponent } from './multisig-page/multisig-page.component';
// import { NodeRewardPageComponent } from './node-reward/reward-page.component';
// import { LiquidityProviderPageComponent } from './liquidity-provider/liquidity-provider.component';
import { ShortAddressPipe } from '../@shared/pipes/short-address.pipe';
import { LoginContainerComponent } from './login-page/login-container/login-container.component';
import { HomePageComponent } from './home-page/home-page.component';

const NG_MODULES = [
    CommonModule,
    ReactiveFormsModule,
    FormsModule,
];

const MAT_MODULES = [
    MatTabsModule,
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule,
    MatTableModule,
    MatCardModule,
    MatGridListModule,
    MatIconModule,
    MatProgressSpinnerModule,
    MatTooltipModule,
];

const PAGE_COMPONENTS = [
    HomePageComponent,
    LoginPageComponent,
    PortfolioPageComponent,
    // SpotPageComponent,
    // FuturesPageComponent,
    // SettingsPageComponent,
    // MultisigPageComponent,
    // NodeRewardPageComponent,
    // LiquidityProviderPageComponent,
    LoginContainerComponent,
];

// const SPOT_COMPONENTS = [
//     SpotMarketsToolbarComponent,
//     SpotTradingGridComponent,
//     SpotBuySellCardComponent,
//     SpotOrderbookCardComponent,
//     SpotBottomCardComponent,
//     SpotPendingTxsComponent,
//     SpotPositionsComponent,
//     SportHistoryCardComponent,
//     SportChartCardComponent,
// ];

// const FUTURES_COMPONENTS = [
//     FuturesMarketsToolbarComponent,
//     FuturesTradingGridComponent,
//     FuturesOrderbookCardComponent,
//     FuturesBuySellCardComponent,
//     FuturesHistoryCardComponent,
// ];

const PIPES = [
    ShortAddressPipe,
];

const imports = [
    ...NG_MODULES,
    ...MAT_MODULES,
];

const declarations = [
    ...PAGE_COMPONENTS,
    // ...SPOT_COMPONENTS,
    // ...FUTURES_COMPONENTS,
    ...PIPES,
];

@NgModule({ imports, declarations })

export class PagesModule { }
