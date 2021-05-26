import { NgModule } from '@angular/core';
import { MatTabsModule } from '@angular/material/tabs';
import { MatFormFieldModule } from '@angular/material/form-field'; 
import { MatInputModule } from '@angular/material/input'; 
import { MatButtonModule } from '@angular/material/button'; 

import { LoginPageComponent } from './login-page/login-page.component';
import { TradingPageComponent } from './trading-page/trading-page.component';

import { MarketsToolbarComponent } from './trading-page/markets-toolbar/markets-toolbar.component'; 
import { CommonModule } from '@angular/common';

@NgModule({
    imports: [
        MatTabsModule,
        MatFormFieldModule,
        MatInputModule,
        MatButtonModule,
        CommonModule,
    ],
    declarations: [
        LoginPageComponent,
        TradingPageComponent,
        MarketsToolbarComponent,
    ]
})

export class PagesModule { }
