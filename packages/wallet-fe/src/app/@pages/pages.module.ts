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
import { SpotPageComponent } from './spot-page/spot-page.component';

import { SpotMarketsToolbarComponent } from './spot-page/spot-markets-toolbar/spot-markets-toolbar.component'; 
import { SpotTradingGridComponent } from './spot-page/spot-trading-grid/spot-trading-grid.component';
import { SpotBuySellCardComponent } from './spot-page/spot-trading-grid/spot-buy-sell-card/spot-buy-sell-card.component';
import { SpotOrderbookCardComponent } from './spot-page/spot-trading-grid/spot-orderbook-card/spot-orderbook-card.component';
import { SpotBottomCardComponent } from './spot-page/spot-trading-grid/spot-bottom-card/spot-bottom-card.component';
import { SpotHistoryCardComponent } from './spot-page/spot-trading-grid/spot-history-card/spot-history-card.component';
import { SpotChartCardComponent } from './spot-page/spot-trading-grid/spot-chart-card/spot-chart-card.component';
import { SpotOrdersComponent } from './spot-page/spot-trading-grid/spot-bottom-card/spot-orders/spot-orders.component';

import { ShortAddressPipe } from '../@shared/pipes/short-address.pipe';
import { LoginContainerComponent } from './login-page/login-container/login-container.component';
import { HomePageComponent } from './home-page/home-page.component';
import { SpotChannelsComponent } from './spot-page/spot-trading-grid/spot-bottom-card/spot-channels/spot-channels.component';
import { SpotRelatedHistoryComponent } from './spot-page/spot-trading-grid/spot-bottom-card/spot-related-history/spot-related-history.component';
import { FuturesPageComponent } from './futures-page/futures-page.component';
import { FuturesMarketsToolbarComponent } from './futures-page/futures-markes-toolbar/spot-markets-toolbar.component';
import { FuturesTradingGridComponent } from './futures-page/futures-trading-grid/futures-trading-grid.component';
import { FuturesChartCardComponent } from './futures-page/futures-trading-grid/futures-chart-card/futures-chart-card.component';
import { FuturesHistoryCardComponent } from './futures-page/futures-trading-grid/futures-history-card/futures-history-card.component';
import { FuturesOrderbookCardComponent } from './futures-page/futures-trading-grid/futures-orderbook-card/futures-orderbook-card.component';
import { FuturesBuySellCardComponent } from './futures-page/futures-trading-grid/futures-buy-sell-card/futures-buy-sell-card.component';
import { FuturesBottomCardComponent } from './futures-page/futures-trading-grid/futures-bottom-card/futures-bottom-card.component';
import { FuturesOrdersComponent } from './futures-page/futures-trading-grid/futures-bottom-card/futures-orders/spot-orders.component';
import { FuturesRelatedHistoryComponent } from './futures-page/futures-trading-grid/futures-bottom-card/futures-related-history/spot-related-history.component';
import { FuturesPositionsComponent } from './futures-page/futures-trading-grid/futures-bottom-card/futures-positions/futures-positions.component';

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
    SpotPageComponent,
    FuturesPageComponent,
    LoginContainerComponent,
];

const SPOT_COMPONENTS = [
    SpotMarketsToolbarComponent,
    SpotTradingGridComponent,
    SpotBuySellCardComponent,
    SpotOrderbookCardComponent,
    SpotBottomCardComponent,
    SpotHistoryCardComponent,
    SpotChartCardComponent,
    SpotOrdersComponent,
    SpotChannelsComponent,
    SpotRelatedHistoryComponent,
];

const FUTURES_COMPONENTS = [
    FuturesMarketsToolbarComponent,
    FuturesTradingGridComponent,
    FuturesChartCardComponent,
    FuturesHistoryCardComponent,
    FuturesOrderbookCardComponent,
    FuturesBuySellCardComponent,
    FuturesBottomCardComponent,
    FuturesOrdersComponent,
    FuturesRelatedHistoryComponent,
    FuturesPositionsComponent,
];

const PIPES = [
    ShortAddressPipe,
];

const imports = [
    ...NG_MODULES,
    ...MAT_MODULES,
];

const declarations = [
    ...PAGE_COMPONENTS,
    ...SPOT_COMPONENTS,
    ...FUTURES_COMPONENTS,
    ...PIPES,
];

@NgModule({ imports, declarations })

export class PagesModule { }
