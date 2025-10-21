import { Injectable } from "@angular/core";
import { LoadingService } from "../loading.service";
import { SocketService } from "../socket.service";
import { IFuturesOrder } from "./futures-orderbook.service";
import { FuturesMarketService  } from "./futures-markets.service";

interface ITradeConf {
    keypair: {
        address: string;
        pubkey: string;
    };
    action: "BUY" | "SELL";
    type: "FUTURES";
    isLimitOrder: boolean;
    marketName: string;
}

export interface IFuturesTradeConf extends ITradeConf {
    props: {
        contract_id: number,
        amount: number,
        margin?: number,
        price: number,
        initMargin: number;
        collateral: number;
        transfer: boolean;
    };
}

@Injectable({
    providedIn: 'root',
})

export class FuturesOrdersService {
    private _openedOrders: IFuturesOrder[] = [];
    

    // === Symbol normalization helpers (internal futures key = numeric string) ===
    private inboundToContractId(sym?: string | null): number | null {
        if (!sym || typeof sym !== 'string') return null;
        const m = sym.trim().match(/^([0-9]+)-perp$/i);
        return m ? Number(m[1]) : null;
    }
    private feKeyForContractId(cid: number | null | undefined): string | null {
        return (cid ?? null) != null ? String(cid) : null; // no FUTURES: prefix, just the number as string
    }

private _orderHistory: any[] = [];

    constructor(
        private socketService: SocketService,
        private loadingService: LoadingService,
        private futureMarketService: FuturesMarketService
    ) { }

    get socket() {
        return this.socketService.socket;
    }

    get openedOrders(): IFuturesOrder[] {
        return this._openedOrders;
    }

    get selectedMarket() {
        return this.futureMarketService.selectedMarket;
    }

    set openedOrders(value: IFuturesOrder[]) {
        const mapIn = (o: any) => {
            const cid = this.inboundToContractId(o?.symbol);
            const _feKey = this.feKeyForContractId(cid);
            return cid != null ? { ...o, contract_id: o.contract_id ?? cid, _feKey } : o;
        };
        this._openedOrders = Array.isArray(value) ? value.map(mapIn) : [];
    }

    get orderHistory() {
        return this._orderHistory;
    }

    set orderHistory(value: any[]) {
        this._orderHistory = value;
    }

    newOrder(orderConf: IFuturesTradeConf) {
        //this.loadingService.tradesLoading = true;
        console.log('emitting new order '+JSON.stringify(orderConf))
        this.socket.emit('new-order', orderConf);
    }

    addLiquidity(orders: IFuturesTradeConf[]) {
        this.socket.emit('many-orders', orders);
    }

    closeOpenedOrder(uuid: string) {
         const sel = this.selectedMarket;
        const contractId  = sel?.contract_id;
        this.socket.emit('close-order', { orderUUID: uuid, contractId });
    }

    closeAllOrders() {
        this._openedOrders.forEach(o => this.closeOpenedOrder(o.uuid));
    }


    // Convenience: opened orders for the currently selected futures market
    get openedOrdersForActive(): IFuturesOrder[] {
        const sel = this.selectedMarket;
        const cid = sel?.contract_id;
        const key = this.feKeyForContractId(cid);
        return key
          ? this._openedOrders.filter((o: any) => o._feKey === key || o.contract_id === cid)
          : this._openedOrders;
    }
}
