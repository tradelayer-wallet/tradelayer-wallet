import { Injectable } from "@angular/core";
import { ToastrService } from "ngx-toastr";
import { obEventPrefix, SocketService } from "../socket.service";
import { ISpotOrder } from "./spot-orderbook.service";

@Injectable({
    providedIn: 'root',
})

export class SpotOrdersService {
    private _openedOrders: ISpotOrder[] = []
    constructor(
        private socketService: SocketService,
        private toastrService: ToastrService
    ) {
        this._subscribeToSocketEvents()
    }

    get socket() {
        return this.socketService.socket;
    }

    get openedOrders(): ISpotOrder[] {
        return this._openedOrders;
    }

    set openedOrders(value: ISpotOrder[]) {
        this._openedOrders = value;
    }

    private _subscribeToSocketEvents() {
        this.socket.on(`${obEventPrefix}::placed-orders`, (openedOrders: ISpotOrder[]) => {
            this.openedOrders = openedOrders
        });

        this.socket.on(`${obEventPrefix}::disconnect`, () => {
            this.openedOrders = [];
        });
    }

    closeOpenedOrder(uuid: string) {
        this.socket.emit('close-order', uuid);
    }
}
