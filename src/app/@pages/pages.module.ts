import { NgModule } from '@angular/core';
import { MatTabsModule } from '@angular/material/tabs';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatTableModule } from '@angular/material/table';
import { MatCardModule } from '@angular/material/card';
import { MatGridListModule } from '@angular/material/grid-list';

import { LoginPageComponent } from './login-page/login-page.component';
import { TradingPageComponent } from './trading-page/trading-page.component';

import { MarketsToolbarComponent } from './trading-page/markets-toolbar/markets-toolbar.component'; 
import { CommonModule } from '@angular/common';
import { ReactiveFormsModule } from '@angular/forms';
import { TradingGridComponent } from './trading-page/main-trading-grid/trading-grid.component';
import { BuySellCardComponent } from './trading-page/main-trading-grid/buy-sell-card/buy-sell-card.component';
import { OrderbookCardComponent } from './trading-page/main-trading-grid/orderbook-card/orderbook-card.component';
import { MatIconModule } from '@angular/material/icon'; 
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { PortfolioPageComponent } from './portfolio-page/portfolio-page.component';
import { BottomCardComponent } from './trading-page/main-trading-grid/bottom-card/bottom-card.component';
import { PendingTxsComponent } from './trading-page/main-trading-grid/bottom-card/pending-txs/pending-txs.component';
import { MatTooltipModule } from '@angular/material/tooltip'; 


@NgModule({
    imports: [
        MatTabsModule,
        MatFormFieldModule,
        MatInputModule,
        MatButtonModule,
        MatTableModule,
        MatCardModule,
        MatGridListModule,
        CommonModule,
        ReactiveFormsModule,
        MatIconModule,
        MatProgressSpinnerModule,
        MatTooltipModule,
    ],
    declarations: [
        LoginPageComponent,
        TradingPageComponent,
        PortfolioPageComponent,
        MarketsToolbarComponent,
        TradingGridComponent,
        BuySellCardComponent,
        OrderbookCardComponent,
        BottomCardComponent,
        PendingTxsComponent,
    ]
})

export class PagesModule { }
