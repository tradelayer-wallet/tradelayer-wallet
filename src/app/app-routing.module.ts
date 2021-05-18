import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';

import { HomePageComponent } from './@pages/home-page/home-page.component';
import { LoginPageComponent } from './@pages/login-page/login-page.component';
import { TradingPageComponent } from './@pages/trading-page/trading-page.component';

export const routes: Routes = [
    {
      path: '',
      component: HomePageComponent,
    },
    {
      path: 'login',
      component: LoginPageComponent,
    },
    {
      path: 'trading',
      component: TradingPageComponent,
    }
  ];

const imports = [ RouterModule.forRoot(routes) ];
const exports = [ RouterModule ];

@NgModule({ imports, exports })
export class AppRoutingModule { }
