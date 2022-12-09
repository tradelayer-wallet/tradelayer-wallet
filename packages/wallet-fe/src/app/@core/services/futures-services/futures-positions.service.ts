import { Injectable } from "@angular/core";
import { ToastrService } from "ngx-toastr";
import { AuthService } from "../auth.service";
import { RpcService } from "../rpc.service";
import { Subscription } from 'rxjs';  

export interface IPosition {
    "entry_price": string;
    "position": string;
    "BANKRUPTCY_PRICE": string;
    "position_margin": string;
    "upnl": string;
}

@Injectable({
    providedIn: 'root',
})

export class FuturesPositionsService {
    private _openedPosition: IPosition | null = null;
    private _selectedContractId: string | null = null;
    private subs$: Subscription | null = null;
    constructor(
        private rpcService: RpcService,
        private authService: AuthService,
        private toastrService: ToastrService,
    ) {}

    get selectedContractId() {
        return this._selectedContractId;
    }

    set selectedContractId(value: string | null) {
        this._selectedContractId = value;
    }

    get activeFutureAddress() {
        return this.authService.activeFuturesKey?.address;
    }

    get openedPosition() {
        return this._openedPosition;
    }

    set openedPosition(value: IPosition | null) {
        this._openedPosition = value;
    }

    onInit(){
        if (this.subs$) return;
        this.subs$ = this.rpcService.blockSubs$.subscribe(block => {
            if (block.type === "LOCAL") return;
            if (!this.activeFutureAddress || !this.selectedContractId) return;
            this.updatePositions();
        });
    }

    async updatePositions() {
        if (!this.activeFutureAddress || !this.selectedContractId) return;
        const params = [this.activeFutureAddress, this.selectedContractId];
        const res = await this.rpcService.rpc('tl_getfullposition', params);
        if (res.error || !res.data) {
            this.toastrService.error(res.error || 'Error with getting Opened positions', 'Error');
            return;
        }
        if (parseFloat(res.data?.['position'] || "0")) {
            this.openedPosition = res.data;
        } else {
            this.openedPosition = null;
        }
    }
}
