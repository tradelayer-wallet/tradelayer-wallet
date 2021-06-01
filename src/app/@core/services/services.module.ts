import { NgModule } from '@angular/core';
import { RpcService } from './rpc.service';
import { DialogService } from './dialogs.service';
import { MenuService } from './menu.service';
import { AuthService } from './auth.service';
import { AddressService } from './address.service';
import { SocketService } from './socket.service';
import { ApiService } from './api.service';

@NgModule({
    providers: [
        RpcService,
        DialogService,
        MenuService,
        AuthService,
        AddressService,
        SocketService,
        ApiService,
    ],
})

export class ServicesModule { }
