import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';

import { HomePageComponent } from './@pages/home-page/home-page.component';
import { LoginPageComponent } from './@pages/login-page/login-page.component';
import { SpotPageComponent } from './@pages/spot-page/spot-page.component';
import { FuturesPageComponent } from './@pages/futures-page/futures-page.component';
import { PortfolioPageComponent } from './@pages/portfolio-page/portfolio-page.component';
import { SettingsPageComponent } from './@pages/settings-page/settings-page.component';
import { MultisigPageComponent } from './@pages/multisig-page/multisig-page.component';
import { NodeRewardPageComponent } from './@pages/node-reward/reward-page.component';

import { RPCGuard } from './@core/guards/rpc.guard';
import { AuthGuard } from './@core/guards/auth.guard';
import { SyncedGuard } from './@core/guards/sync.guard';

export const routes: Routes = [
  {
    path: '',
    canActivate: [ RPCGuard ], 
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
        canActivate: [AuthGuard, SyncedGuard]
      },
      {
        path: 'futures',
        component: FuturesPageComponent,
        canActivate: [AuthGuard, SyncedGuard]
      },
      {
        path: 'portfolio',
        component: PortfolioPageComponent,
        canActivate: [AuthGuard],
      },
      {
        path: 'settings',
        component: SettingsPageComponent,
        canActivate: [AuthGuard, SyncedGuard],
      },
      {
        path: 'multisig',
        component: MultisigPageComponent,
      },
      {
        path: 'reward',
        component: NodeRewardPageComponent,
        canActivate: [AuthGuard, SyncedGuard],
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
