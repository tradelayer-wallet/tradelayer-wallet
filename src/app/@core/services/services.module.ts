import { NgModule } from '@angular/core';
import { RpcService } from './rpc.service';
import { DialogService } from './dialogs.service';
import { MenuService } from './menu.service';

@NgModule({
    providers: [
        RpcService,
        DialogService,
        MenuService,
    ],
})

export class ServicesModule { }
