import { NgModule } from '@angular/core';

import { LayoutComponent } from './layout/layout.component';

import { MatToolbarModule } from '@angular/material/toolbar';
import { MatGridListModule } from '@angular/material/grid-list';
import { MatIconModule } from '@angular/material/icon/';
import { MatButtonModule } from '@angular/material/button';
import { MatTabsModule } from '@angular/material/tabs';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { HeaderComponent } from './components/header/header.component';
import { BrowserModule } from '@angular/platform-browser';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';

const MAT_MODULES = [
  MatToolbarModule,
  MatGridListModule,
  MatIconModule,
  MatButtonModule,
  MatTabsModule,
  MatSlideToggleModule,
  MatProgressSpinnerModule,
];

@NgModule({
  imports: [
    BrowserModule,
    ...MAT_MODULES,
  ],
  declarations: [
      LayoutComponent,
      HeaderComponent,
    ],
  exports: [
    LayoutComponent,
  ],
})

export class ThemeModule { }
