import { NgModule } from '@angular/core';

import { CommonModule } from '@angular/common';
import { ReactiveFormsModule } from '@angular/forms';

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
import { SpotPageComponent } from './spot-page/spot-page.component';
import { FuturesPageComponent } from './futures-page/futures-page.component';
import { PortfolioPageComponent } from './portfolio-page/portfolio-page.component';

import { MarketsToolbarComponent } from './spot-page/markets-toolbar/markets-toolbar.component'; 
import { TradingGridComponent } from './spot-page/main-trading-grid/trading-grid.component';
import { BuySellCardComponent } from './spot-page/main-trading-grid/buy-sell-card/buy-sell-card.component';
import { OrderbookCardComponent } from './spot-page/main-trading-grid/orderbook-card/orderbook-card.component';
import { BottomCardComponent } from './spot-page/main-trading-grid/bottom-card/bottom-card.component';
import { PendingTxsComponent } from './spot-page/main-trading-grid/bottom-card/pending-txs/pending-txs.component';
import { PositionsComponent } from './spot-page/main-trading-grid/bottom-card/positions/positions.component';

const NG_MODULES = [
    CommonModule,
    ReactiveFormsModule,
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
    LoginPageComponent,
    SpotPageComponent,
    FuturesPageComponent,
    PortfolioPageComponent,
];

const SUB_COMPONENTS = [
    MarketsToolbarComponent,
    TradingGridComponent,
    BuySellCardComponent,
    OrderbookCardComponent,
    BottomCardComponent,
    PendingTxsComponent,
    PositionsComponent,
];

const imports = [
    ...NG_MODULES,
    ...MAT_MODULES,
];

const declarations = [
    ...PAGE_COMPONENTS,
    ...SUB_COMPONENTS,
];

@NgModule({ imports, declarations })

export class PagesModule { }
