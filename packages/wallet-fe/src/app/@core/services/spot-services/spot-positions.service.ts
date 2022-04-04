import { Injectable } from "@angular/core";
import { ToastrService } from "ngx-toastr";
import { SocketService } from "../socket.service";
import { ISpotOrder } from "./spot-orderbook.service";

@Injectable({
    providedIn: 'root',
})

export class SpotPositionsService {
    private _openedPositions: ISpotOrder[] = []
    constructor(
        private socketService: SocketService,
        private toastrService: ToastrService
    ) {
        this._subscribeToSocketEvents()
    }

    get socket() {
        return this.socketService.socket;
    }

    get openedPositions(): ISpotOrder[] {
        return this._openedPositions;
    }

    set openedPositions(value: ISpotOrder[]) {
        this._openedPositions = value;
    }

    private _subscribeToSocketEvents() {
        this.socket.on('OBSERVER::placed-orders', (openedPositions: ISpotOrder[]) => {
            this.openedPositions = openedPositions
        });
    }

    closeOpenedPosition(uuid: string) {
        this.socket.emit('close-order', uuid);
        this.toastrService.success('Order was closed successful', 'Success');
    }
}
