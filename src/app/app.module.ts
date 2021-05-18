import { NgModule } from '@angular/core';
import { BrowserModule } from '@angular/platform-browser';

import { AppRoutingModule } from './app-routing.module';
import { AppComponent } from './app.component';

import { CoreModule } from './@core/core.module';
import { PagesModule } from './@pages/pages.module';
import { SharedModule } from './@shared/shared.module';
import { ThemeModule } from './@theme/theme.module';

import { BrowserAnimationsModule } from '@angular/platform-browser/animations';
import { CommonModule } from '@angular/common';

const NG_MODULES = [
  BrowserModule,
  AppRoutingModule,
  BrowserAnimationsModule,
  CommonModule
];

const TL_MODULES = [
  CoreModule,
  PagesModule,
  SharedModule,
  ThemeModule,
];

const imports = [
  ...NG_MODULES,
  ...TL_MODULES,
];

const declarations = [AppComponent];
const bootstrap = [AppComponent];

@NgModule({ declarations, imports, bootstrap })
export class AppModule { }
