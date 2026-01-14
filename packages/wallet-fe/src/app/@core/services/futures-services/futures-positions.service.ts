import { Injectable } from "@angular/core";
import { ToastrService } from "ngx-toastr";
import { AuthService } from "../auth.service";
import { RpcService } from "../rpc.service";
import { ApiService } from "../api.service";
import { Subscription, interval } from 'rxjs';

export interface IPosition {
    entry_price: string;
    position: string;
    BANKRUPTCY_PRICE: string;
    position_margin: string;
    upnl: string;
}

@Injectable({ providedIn: 'root' })
export class FuturesPositionsService {

    // ---------------------------------------------------------------------
    // CORE STATE (UNCHANGED FROM WORKING VERSION)
    // ---------------------------------------------------------------------
    private _openedPosition: IPosition | null = null;
    private _selectedContractId: string | null = null;

    private subs$: Subscription | null = null;
    private mempoolSubs$: Subscription | null = null;

    // Pending (mempool) + realtime (mark)
    private _pendingPositionDelta: number = 0;
    private _pendingUpnlDelta: number = 0;
    private _markPrice: number | null = null;

    // ---------------------------------------------------------------------
    // COMPATIBILITY MAPS (USED BY COMPONENT)
    // ---------------------------------------------------------------------
    pendingPositionDeltaByContract: Record<number, number> = {};
    pendingUpnlDeltaByContract: Record<number, number> = {};

    constructor(
        private rpcService: RpcService,
        private authService: AuthService,
        private toastrService: ToastrService,
        private apiService: ApiService,
    ) {}

    // ---------------------------------------------------------------------
    // ACCESSORS (UNCHANGED)
    // ---------------------------------------------------------------------
    get pendingPositionDelta() {
        return this._pendingPositionDelta;
    }

    get pendingUpnlDelta() {
        return this._pendingUpnlDelta;
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

    // Alias expected by component
    get activeAddress() {
        return this.activeFutureAddress;
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

    // ---------------------------------------------------------------------
    // MARK PRICE (UNCHANGED)
    // ---------------------------------------------------------------------
    set markPrice(v: number | null) {
        this._markPrice = (typeof v === 'number' && Number.isFinite(v)) ? v : null;
        this.recomputeRealtimeUpnlDelta();
    }

    // ---------------------------------------------------------------------
    // INIT (UNCHANGED BEHAVIOR)
    // ---------------------------------------------------------------------
    onInit(address?: string, contractId?: number) {
        if (contractId !== undefined) {
            this.selectedContractId = String(contractId);
        }

        if (this.subs$) return;

        this.subs$ = this.rpcService.blockSubs$.subscribe(() => {
            if (!this.activeFutureAddress || !this.selectedContractId) return;
            this.updatePositions();
        });

        if (!this.mempoolSubs$) {
            this.mempoolSubs$ = interval(750).subscribe(() => {
                if (!this.activeFutureAddress || !this.selectedContractId) return;
                this.scanMempoolPending();
                this.recomputeRealtimeUpnlDelta();
            });
        }
    }

    // ---------------------------------------------------------------------
    // CONFIRMED POSITION (EXACTLY AS THIS MORNING)
    // ---------------------------------------------------------------------
    updatePositions() {
        if (!this.activeFutureAddress || !this.selectedContractId) return;

        const params = {
            address: this.activeFutureAddress,
            contractId: this.selectedContractId
        };

        this.tlApi.rpc('contractPosition', params).subscribe(res => {
            if (res.error || !res.data) {
                this.toastrService.error(res.error || 'Error getting opened position', 'Error');
                this.openedPosition = null;
                this.clearPending();
                return;
            }

            const raw = res.data;
            const positionValue = Number(raw.contracts || 0);

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
                this.clearPending();
            }
        }, err => {
            console.error('❌ RPC error in updatePositions:', err);
            this.toastrService.error('Network error fetching position', 'Error');
        });
    }

    // ---------------------------------------------------------------------
    // MEMPOOL PENDING (ADDED, BUT SAME RPC STYLE)
    // ---------------------------------------------------------------------
    scanMempoolPending() {
        if (!this.activeFutureAddress || !this.selectedContractId) {
            this.clearPending();
            return;
        }

        const cid = Number(this.selectedContractId);

        this.rpcService.rpc('getrawmempool', [true])
            .then((mempool: any) => {
                const txids = Object.keys(mempool || {});
                if (!txids.length) {
                    this.clearPending();
                    return;
                }

                let count = 0;
                let checked = 0;
                const limit = Math.min(txids.length, 80); // safety cap

                for (const txid of txids.slice(0, limit)) {
                    this.rpcService.rpc('getrawtransaction', [txid, true])
                        .then(async (tx: any) => {
                            checked++;

                            try {
                                // channel address is vin[0]
                                const channelAddress = tx?.vin?.[0]?.address;
                                if (!channelAddress) return;

                                // 🔑 USE YOUR HELPER
                                const side = await this.resolveChannelSide(channelAddress);
                                if (!side) return; // not our channel

                                // parse OP_RETURN TL payloads
                                for (const v of tx?.vout || []) {
                                    const asm = v?.scriptPubKey?.asm || '';
                                    if (!asm.startsWith('OP_RETURN')) continue;

                                    const hex = asm.split(' ')[1];
                                    if (!hex) continue;

                                    const payload = Buffer.from(hex, 'hex').toString('utf8');
                                    if (!payload.startsWith('tl')) continue;

                                    const comma = payload.indexOf(',');
                                    if (comma === -1) continue;

                                    const parsedCid = parseInt(payload.slice(3, comma), 36);
                                    if (parsedCid === cid) {
                                        count++;
                                    }
                                }
                            } catch {
                                // fake UX → swallow
                            }

                            if (checked >= limit) {
                                this._pendingPositionDelta = count;
                                this.pendingPositionDeltaByContract[cid] = count;
                            }
                        })
                        .catch(() => {
                            checked++;
                            if (checked >= limit) {
                                this._pendingPositionDelta = count;
                                this.pendingPositionDeltaByContract[cid] = count;
                            }
                        });
                }
            })
            .catch(() => {
                this.clearPending();
            });
    }


    private async resolveChannelSide(channelAddress: string): Promise<'A' | 'B' | null> {
        try {
            const res = await this.apiService.tlApi.rpc('tl_getChannel', [channelAddress]);

            const channel = res?.data;
            if (!channel?.participants) return null;

            const { A, B } = channel.participants;

            if (A === this.activeFutureAddress) return 'A';
            if (B === this.activeFutureAddress) return 'B';

            return null;
        } catch (_err) {
            return null;
        }
    }


    // ---------------------------------------------------------------------
    // REALTIME UPNL (UNCHANGED)
    // ---------------------------------------------------------------------
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

        const cid = Number(this.selectedContractId);
        this._pendingUpnlDelta = Number.isFinite(delta) ? delta : 0;
        this.pendingUpnlDeltaByContract[cid] = this._pendingUpnlDelta;
    }

    // ---------------------------------------------------------------------
    // HELPERS
    // ---------------------------------------------------------------------
    private clearPending() {
        const cid = Number(this.selectedContractId);
        this._pendingPositionDelta = 0;
        this._pendingUpnlDelta = 0;
        delete this.pendingPositionDeltaByContract[cid];
        delete this.pendingUpnlDeltaByContract[cid];
    }
}
