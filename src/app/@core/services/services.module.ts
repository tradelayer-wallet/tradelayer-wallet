import { NgModule } from '@angular/core';
import { RpcService } from './rpc.service';
import { DialogService } from './dialogs.service';
import { XmlrpcModule } from 'angular2-xmlrpc';

@NgModule({
    providers: [
        RpcService,
        DialogService,
        XmlrpcModule,
    ],
})

export class ServicesModule { }
