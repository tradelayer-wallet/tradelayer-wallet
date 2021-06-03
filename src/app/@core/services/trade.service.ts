import { Injectable } from "@angular/core";
import { ToastrService } from "ngx-toastr";
import { getPubKey } from "src/app/utils/litecore.util";
import { AddressService } from "./address.service";
import { SocketEmits, SocketService } from "./socket.service";

export interface ITradeConf {
    propIdForSale: number;
    propIdDesired: number;
    amountForSale: number;
    amountDeisred: number;
    clientPubKey?: string;
    clientAddress?: string;
}

@Injectable({
    providedIn: 'root',
})

export class TradeService {
    constructor(
        private socketService: SocketService,
        private toasterService: ToastrService,
        private addressService: AddressService,
    ) {
        this.handleSocketEvents()
    }

    get keyPair() {
        return this.addressService.activeKeyPair;
    }

    get socket() {
        return this.socketService.socket;
    }
    initTrade(tradeConf: ITradeConf) {
        if (tradeConf.propIdForSale === 999 ) {
            this.handleLTCInstantTrade(tradeConf);
        } else {
            console.log('STILL IN DEVELOPMENT');
        }
    }

    private handleLTCInstantTrade(tradeConf: ITradeConf) {
        console.log('LTC INSTANT TRADE');
        const _tradeConf: ITradeConf = {
            ...tradeConf,
            clientPubKey: this.keyPair?.pubKey,
            clientAddress: this.keyPair?.address,
        };
        this.socket.emit(SocketEmits.LTC_INSTANT_TRADE, _tradeConf);
    }

    private handleSocketEvents() {
        this.socket.on('TRADE_REJECTION', (reason) => {
            this.toasterService.error('Trade Rejected', `Reason: ${reason}`);
        })
    }
}
