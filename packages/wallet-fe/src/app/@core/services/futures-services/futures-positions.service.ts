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
    private pendingPositionUpdateId: ReturnType<typeof setTimeout> | null = null;
    private pendingMempoolScanId: ReturnType<typeof setTimeout> | null = null;
    private positionUpdateInProgress = false;
    private mempoolScanInProgress = false;
    private readonly positionPollMs = 10000;
    private readonly mempoolPollMs = 5000;

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
            this.scheduleUpdatePositions();
        });

        if (!this.mempoolSubs$) {
            this.mempoolSubs$ = interval(this.mempoolPollMs).subscribe(() => {
                if (!this.activeFutureAddress || !this.selectedContractId) return;
                this.scheduleMempoolScan();
                this.recomputeRealtimeUpnlDelta();
            });
        }
    }

    private scheduleUpdatePositions() {
        if (this.pendingPositionUpdateId) {
            clearTimeout(this.pendingPositionUpdateId);
        }
        this.pendingPositionUpdateId = setTimeout(() => {
            this.pendingPositionUpdateId = null;
            this.updatePositions();
        }, this.positionPollMs);
    }

    private scheduleMempoolScan() {
        if (this.pendingMempoolScanId) {
            clearTimeout(this.pendingMempoolScanId);
        }
        this.pendingMempoolScanId = setTimeout(() => {
            this.pendingMempoolScanId = null;
            this.scanMempoolPending();
        }, this.mempoolPollMs);
    }

    // ---------------------------------------------------------------------
    // CONFIRMED POSITION (EXACTLY AS THIS MORNING)
    // ---------------------------------------------------------------------
    updatePositions() {
        if (!this.activeFutureAddress || !this.selectedContractId) return;
        if (this.positionUpdateInProgress) return;
        this.positionUpdateInProgress = true;

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
            this.positionUpdateInProgress = false;
        }, err => {
            console.error('❌ RPC error in updatePositions:', err);
            this.toastrService.error('Network error fetching position', 'Error');
            this.positionUpdateInProgress = false;
        });
    }

    // ---------------------------------------------------------------------
    // MEMPOOL PENDING (ADDED, BUT SAME RPC STYLE)
    // ---------------------------------------------------------------------
    scanMempoolPending() {
        if (!this.activeFutureAddress || !this.selectedContractId) {
            console.warn('[MP] missing address or contractId', {
                address: this.activeFutureAddress,
                cid: this.selectedContractId
            });
            this.clearPending();
            return;
        }
        if (this.mempoolScanInProgress) return;
        this.mempoolScanInProgress = true;

        const cid = Number(this.selectedContractId);
        console.log('[MP] scan start', { cid, address: this.activeFutureAddress });

        this.rpcService.rpc('getrawmempool', [true])
            .then((mempool: any) => {
                const txids = Object.keys(mempool || {});
                console.log('[MP] mempool size', txids.length);

                if (!txids.length) {
                    this.clearPending();
                    this.mempoolScanInProgress = false;
                    return;
                }

                let count = 0;
                let checked = 0;
                const limit = Math.min(txids.length, 80);

                for (const txid of txids.slice(0, limit)) {
                    this.rpcService.rpc('getrawtransaction', [txid, true])
                        .then(async (tx: any) => {
                            checked++;

                            if (!tx) {
                                console.warn('[MP] null tx', txid);
                                return;
                            }

                            const channelAddress =
                                tx?.vin?.[0]?.address ??
                                tx?.vin?.[0]?.prevout?.scriptPubKey?.address;

                            if (!channelAddress) {
                                console.debug('[MP] no channel address', txid);
                                return;
                            }

                            console.log('[MP] tx channel candidate', {
                                txid,
                                channelAddress
                            });

                            const side = await this.resolveChannelSide(channelAddress);
                            if (!side) {
                                console.debug('[MP] not our channel', channelAddress);
                                return;
                            }

                            console.log('[MP] matched channel', {
                                txid,
                                channelAddress,
                                side
                            });

                            for (const v of tx?.vout || []) {
                                const asm = v?.scriptPubKey?.asm || '';
                                if (!asm.startsWith('OP_RETURN')) continue;

                                const hex = asm.split(' ')[1];
                                if (!hex) continue;

                                let payload: string;
                                try {
                                    payload = Buffer.from(hex, 'hex').toString('utf8');
                                } catch {
                                    console.warn('[MP] hex decode failed', hex);
                                    continue;
                                }

                                if (!payload.startsWith('tl')) {
                                    console.debug('[MP] non-TL OP_RETURN', payload);
                                    continue;
                                }

                                const comma = payload.indexOf(',');
                                if (comma === -1) {
                                    console.warn('[MP] malformed TL payload', payload);
                                    continue;
                                }

                                const parsedCid = parseInt(payload.slice(3, comma), 36);

                                console.debug('[MP] TL payload', {
                                    payload,
                                    parsedCid,
                                    expectedCid: cid
                                });

                                if (parsedCid === cid) {
                                    count++;
                                    console.log('[MP] ✔ pending delta++', {
                                        txid,
                                        count
                                    });
                                }
                            }

                            if (checked >= limit) {
                                console.log('[MP] scan complete', {
                                    checked,
                                    count
                                });
                                this._pendingPositionDelta = count;
                                this.pendingPositionDeltaByContract[cid] = count;
                                this.mempoolScanInProgress = false;
                            }
                        })
                        .catch(err => {
                            checked++;
                            console.error('[MP] getrawtransaction failed', {
                                txid,
                                err
                            });

                            if (checked >= limit) {
                                this._pendingPositionDelta = count;
                                this.pendingPositionDeltaByContract[cid] = count;
                                this.mempoolScanInProgress = false;
                            }
                        });
                }
            })
            .catch(err => {
                console.error('[MP] getrawmempool failed', err);
                this.clearPending();
                this.mempoolScanInProgress = false;
            });
    }

    private async resolveChannelSide(
        channelAddress: string
        ): Promise<'A' | 'B' | null> {
            try {
                console.debug('[CH] resolve channel', channelAddress);

                const res: any = await (this.apiService.tlApi
                    .rpc('tl_getChannel', [channelAddress]) as any).toPromise();

                const channel = res?.data ?? res;
                const participants = channel?.participants ?? channel?.data?.participants;

                if (!participants) {
                    console.warn('[CH] no participants', channelAddress, channel);
                    return null;
                }

                const { A, B } = participants;

                console.debug('[CH] channel participants', {
                    channelAddress,
                    A,
                    B,
                    me: this.activeFutureAddress
                });

                if (A === this.activeFutureAddress) return 'A';
                if (B === this.activeFutureAddress) return 'B';

                console.debug('[CH] address not in channel', channelAddress);
                return null;
            } catch (err) {
                console.error('[CH] resolve failed', channelAddress, err);
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
