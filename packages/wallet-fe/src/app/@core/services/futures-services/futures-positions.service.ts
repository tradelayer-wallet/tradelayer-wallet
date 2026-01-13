import { Injectable } from "@angular/core";
import { ToastrService } from "ngx-toastr";
import { AuthService } from "../auth.service";
import { RpcService } from "../rpc.service";
import { ApiService } from "../api.service";

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

    // Pending (mempool) + realtime (mark) deltas for UI parentheses
    private _pendingPositionDelta: number = 0;
    private _pendingUpnlDelta: number = 0;
    private _markPrice: number | null = null;

    constructor(
        private rpcService: RpcService,
        private authService: AuthService,
        private toastrService: ToastrService,
        private apiService: ApiService,
    ) {}

    get pendingPositionDelta() {
        return this._pendingPositionDelta;
    }

    get pendingUpnlDelta() {
        return this._pendingUpnlDelta;
    }

    // Hook for TradingView (or any price feed) to set current mark price
    set markPrice(v: number | null) {
        this._markPrice = (typeof v === 'number' && Number.isFinite(v)) ? v : null;
        this.recomputeRealtimeUpnlDelta();
    }

    get selectedContractId() {
        return this._selectedContractId;
    }

    set selectedContractId(value: string | null) {
        this._selectedContractId = value;
    }

    get activeFutureAddress() {
        return this.authService.walletAddresses[0];
    }

     get tlApi() {
        return this.apiService.newTlApi;
    }

    get openedPosition() {
        return this._openedPosition;
    }

    set openedPosition(value: IPosition | null) {
        this._openedPosition = value;
        this.recomputeRealtimeUpnlDelta();
    }

    onInit(){
        console.log('this sub '+this.subs$)
        if (this.subs$) return;
        this.subs$ = this.rpcService.blockSubs$.subscribe(block => {
            console.log("BLOCK RECEIVED, activeFutureAddress:", this.activeFutureAddress, "selectedContractId:", this.selectedContractId);
            if (!this.activeFutureAddress || !this.selectedContractId) return;
            this.updatePositions();
        });
    }

    async updatePositions() {
        if (!this.activeFutureAddress || !this.selectedContractId) return;

        const params = {
            address: this.activeFutureAddress,
            contractId: this.selectedContractId
        };

        try {
            const res = await this.tlApi.rpc('contractPosition', params).toPromise();
            console.log('position update ' + JSON.stringify(res.data));
            if (res.error || !res.data) {
                this.toastrService.error(res.error || 'Error getting opened position', 'Error');
                this.openedPosition = null;
                this._pendingPositionDelta = 0;
                this._pendingUpnlDelta = 0;
                return;
            }

            const raw = res.data;

            // Change here: map backend keys to what the UI expects
            const positionValue = parseFloat(raw.contracts || "0");

            if (positionValue) {
                this.openedPosition = {
                    position: raw.contracts,
                    entry_price: raw.avgPrice,
                    BANKRUPTCY_PRICE: raw.bankruptcyPrice,
                    position_margin: raw.margin,
                    upnl: raw.unrealizedPNL,
                };
            } else {
                this.openedPosition = null;
                this._pendingPositionDelta = 0;
                this._pendingUpnlDelta = 0;
            }

            // Refresh mempool delta (if endpoint exists)
            await this.scanMempoolPending();

        } catch (err) {
            console.error('❌ RPC error in updatePositions:', err);
            this.toastrService.error('Network error fetching position', 'Error');
        }
    }

    // -------------------------------------------------------------------------
    // Mempool scanner hook: returns net contracts delta if all unconfirmed fills confirm
    // Expected shapes supported:
    //   res.data.contractsDelta
    //   res.data.positionDelta
    // -------------------------------------------------------------------------
    async scanMempoolPending() {
        try {
            const params = { address: this.activeFutureAddress, contractId: this.selectedContractId };
            const res = await this.tlApi.rpc('mempoolPositionDelta', params).toPromise();
            const rawDelta = res?.data?.contractsDelta ?? res?.data?.positionDelta ?? 0;
            const delta = Number(rawDelta);
            this._pendingPositionDelta = Number.isFinite(delta) ? delta : 0;
        } catch (_e) {
            // If not wired yet, keep UI stable
            this._pendingPositionDelta = 0;
        }
    }

    // -------------------------------------------------------------------------
    // Realtime UPNL delta: (approxRealtimeUpnl - backendUpnl)
    // NOTE: Simplified linear approximation; adjust if you use multipliers/quanto.
    // -------------------------------------------------------------------------
    private recomputeRealtimeUpnlDelta() {
        if (!this._openedPosition || this._markPrice === null) {
            this._pendingUpnlDelta = 0;
            return;
        }

        const contracts = Number(this._openedPosition.position);
        const entry = Number(this._openedPosition.entry_price);
        const backendUpnl = Number(this._openedPosition.upnl);

        if (!Number.isFinite(contracts) || !Number.isFinite(entry) || !Number.isFinite(backendUpnl)) {
            this._pendingUpnlDelta = 0;
            return;
        }

        const approxRealtimeUpnl = (this._markPrice - entry) * contracts;
        const delta = approxRealtimeUpnl - backendUpnl;
        this._pendingUpnlDelta = Number.isFinite(delta) ? delta : 0;
    }
}
