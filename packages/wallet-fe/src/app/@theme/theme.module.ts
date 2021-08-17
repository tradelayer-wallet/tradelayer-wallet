import { NgModule } from '@angular/core';
import { BrowserModule } from '@angular/platform-browser';

import { MatToolbarModule } from '@angular/material/toolbar';
import { MatGridListModule } from '@angular/material/grid-list';
import { MatIconModule } from '@angular/material/icon/';
import { MatButtonModule } from '@angular/material/button';
import { MatTabsModule } from '@angular/material/tabs';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';

import { LayoutComponent } from './layout/layout.component';
import { HeaderComponent } from './components/header/header.component';

const NG_MODULES = [
  BrowserModule,
];

const MAT_MODULES = [
  MatToolbarModule,
  MatGridListModule,
  MatIconModule,
  MatButtonModule,
  MatTabsModule,
  MatSlideToggleModule,
  MatProgressSpinnerModule,
];

const COMPONENTS = [
  LayoutComponent,
  HeaderComponent,
];

const imports = [
  ...NG_MODULES,
  ...MAT_MODULES,
];

const declarations = [
  ...COMPONENTS,
];

const exports = [
  LayoutComponent,
];

@NgModule({ imports, declarations, exports })
export class ThemeModule { }
