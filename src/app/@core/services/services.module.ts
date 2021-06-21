import { NgModule } from '@angular/core';
import { RpcService } from './rpc.service';
import { DialogService } from './dialogs.service';
import { MenuService } from './menu.service';
import { AuthService } from './auth.service';
import { AddressService } from './address.service';
import { SocketService } from './socket.service';
import { ApiService } from './api.service';
import { BalanceService } from './balance.service';
import { TradeService } from './trade.service';
import { TxsService } from './txs.service';
import { LoadingService } from './loading.service';

@NgModule({
    providers: [
        RpcService,
        DialogService,
        MenuService,
        AuthService,
        AddressService,
        SocketService,
        ApiService,
        BalanceService,
        TradeService,
        TxsService,
        LoadingService,
    ],
})

export class ServicesModule { }
