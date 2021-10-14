import { NgModule } from '@angular/core';

import { ServicesModule } from './services/services.module';

const imports = [
    ServicesModule,
    // ApisModule,
];


@NgModule({ imports })
export class CoreModule { }
