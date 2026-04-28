import { NgModule } from '@angular/core';

import { BrowserModule } from '@angular/platform-browser';
import { AppRoutingModule } from './app-routing.module';
import { BrowserAnimationsModule } from '@angular/platform-browser/animations';
import { CommonModule } from '@angular/common';
import { HTTP_INTERCEPTORS, HttpClientModule } from '@angular/common/http';

import { PagesModule } from './@pages/pages.module';
import { SharedModule } from './@shared/shared.module';
import { ThemeModule } from './@theme/theme.module';
import { ToastrModule } from 'ngx-toastr';
import { LocalApiAuthInterceptor } from './@core/interceptors/local-api-auth.interceptor';

import { AppComponent } from './app.component';

const NG_MODULES = [
  BrowserModule,
  AppRoutingModule,
  BrowserAnimationsModule,
  CommonModule,
  HttpClientModule
];

const toastrOptionsObject = {
  positionClass: 'custom-toastr',
  maxOpened: 8,
  timeOut: 3000,
  countDuplicates: true,
};

const TL_MODULES = [
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
const providers = [
  {
    provide: HTTP_INTERCEPTORS,
    useClass: LocalApiAuthInterceptor,
    multi: true,
  },
];

@NgModule({ declarations, imports, providers, bootstrap })
export class AppModule { }
