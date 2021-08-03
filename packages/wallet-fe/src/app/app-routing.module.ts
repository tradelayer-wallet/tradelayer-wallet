import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';

import { HomePageComponent } from './@pages/home-page/home-page.component';
import { LoginPageComponent } from './@pages/login-page/login-page.component';
import { SpotPageComponent } from './@pages/spot-page/spot-page.component';
import { FuturesPageComponent } from './@pages/futures-page/futures-page.component';

import { RPCGuard } from './@core/guards/rpc.guard';
import { AuthGuard } from './@core/guards/auth.guard';
import { PortfolioPageComponent } from './@pages/portfolio-page/portfolio-page.component';

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
          path: 'spot',
          component: SpotPageComponent,
          canActivate: [AuthGuard]
        },
        {
          path: 'futures',
          component: FuturesPageComponent,
          canActivate: [AuthGuard]
        },
        {
          path: 'portfolio',
          component: PortfolioPageComponent,
          canActivate: [AuthGuard]
        },
      ],
  },
];

const imports = [ RouterModule.forRoot(routes) ];
const exports = [ RouterModule ];

@NgModule({ imports, exports })
export class AppRoutingModule { }
