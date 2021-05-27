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
    ],
    declarations: [
        LoginPageComponent,
        TradingPageComponent,
        MarketsToolbarComponent,
    ]
})

export class PagesModule { }
