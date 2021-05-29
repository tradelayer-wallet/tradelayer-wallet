import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';

import { HomePageComponent } from './@pages/home-page/home-page.component';
import { LoginPageComponent } from './@pages/login-page/login-page.component';
import { TradingPageComponent } from './@pages/trading-page/trading-page.component';

import { RPCGuard } from './@core/guards/rpc.guard';
import { AuthGuard } from './@core/guards/auth.guard';

export const routes: Routes = [
  {
    path: '',
    canActivate:[ RPCGuard ], 
    children: [
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
          canActivate: [AuthGuard]
        }
      ],
  },
];

const imports = [ RouterModule.forRoot(routes) ];
const exports = [ RouterModule ];

@NgModule({ imports, exports })
export class AppRoutingModule { }
