import { NgModule } from '@angular/core';
import { RpcService } from './rpc.service';
import { DialogService } from './dialogs.service';

@NgModule({ 
    providers: [
        RpcService,
        DialogService,
    ],
})

export class ServicesModule { }
