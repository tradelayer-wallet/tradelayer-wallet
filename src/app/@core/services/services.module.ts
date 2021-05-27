import { NgModule } from '@angular/core';
import { RpcService } from './rpc.service';
import { DialogService } from './dialogs.service';
import { MenuService } from './menu.service';
import { AuthService } from './auth.service';

@NgModule({
    providers: [
        RpcService,
        DialogService,
        MenuService,
        AuthService,
    ],
})

export class ServicesModule { }
