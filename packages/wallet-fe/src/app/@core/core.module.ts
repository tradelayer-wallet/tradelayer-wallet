import { NgModule } from '@angular/core';

import { ServicesModule } from './services/services.module';
import { ApisModule } from './apis/apis.module';

const imports = [
    ServicesModule,
    ApisModule,
];


@NgModule({ imports })
export class CoreModule { }
