import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import { AuthGuard } from './@core/guards/auth.guard';
import { RPCGuard } from './@core/guards/rpc.guard';
import { FuturesPageComponent } from './@pages/futures-page/futures-page.component';

import { HomePageComponent } from './@pages/home-page/home-page.component';
import { LoginPageComponent } from './@pages/login-page/login-page.component';
import { PortfolioPageComponent } from './@pages/portfolio-page/portfolio-page.component';
import { SpotPageComponent } from './@pages/spot-page/spot-page.component';

export const routes: Routes = [
  {
    path: '',
    canActivate: [RPCGuard],
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
        path: 'portfolio',
        component: PortfolioPageComponent,
        canActivate: [AuthGuard],
      },
      {
        path: 'spot',
        component: SpotPageComponent,
        canActivate: [AuthGuard],
      },
      {
        path: 'futures',
        component: FuturesPageComponent,
        canActivate: [AuthGuard],
      },
      {
        path: '**',
        component: HomePageComponent,
      },
    ],
  },
];

const imports = [ RouterModule.forRoot(routes) ];
const exports = [ RouterModule ];

@NgModule({ imports, exports })
export class AppRoutingModule { }
