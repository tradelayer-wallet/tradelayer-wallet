import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import { RPCGuard } from './@core/guards/rpc.guard';

import { HomePageComponent } from './@pages/home-page/home-page.component';

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
