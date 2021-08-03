import { NgModule } from '@angular/core';

import { BrowserModule } from '@angular/platform-browser';
import { AppRoutingModule } from './app-routing.module';
import { BrowserAnimationsModule } from '@angular/platform-browser/animations';
import { CommonModule } from '@angular/common';
import { HttpClientModule } from '@angular/common/http';

import { CoreModule } from './@core/core.module';
import { PagesModule } from './@pages/pages.module';
import { SharedModule } from './@shared/shared.module';
import { ThemeModule } from './@theme/theme.module';
import { ToastrModule } from 'ngx-toastr';

import { AppComponent } from './app.component';

const NG_MODULES = [
  BrowserModule,
  AppRoutingModule,
  BrowserAnimationsModule,
  CommonModule,
  HttpClientModule
];

const toastrOptionsObject = {
  maxOpened: 8,
  newestOnTop: true,
  positionClass: 'toast-bottom-right',
  preventDuplicates: false,
  timeOut: 1500,
};

const TL_MODULES = [
  CoreModule,
  PagesModule,
  SharedModule,
  ThemeModule,
  ToastrModule.forRoot(toastrOptionsObject),
];

const imports = [
  ...NG_MODULES,
  ...TL_MODULES,
];

const declarations = [AppComponent];
const bootstrap = [AppComponent];
@NgModule({ declarations, imports, bootstrap })
export class AppModule { }
