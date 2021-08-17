import { Injectable } from "@angular/core";

interface IFuturesOrder {

}

@Injectable({
    providedIn: 'root',
})

export class FuturesTxsService {
    private _futuresOrders: IFuturesOrder[] = [];
    constructor() {}

    get futuresOrders() {
        return this._futuresOrders;
    }

    set futuresOrders(value: IFuturesOrder[]) {
        this._futuresOrders = value;
    }

    async addFuturesOrder(order: IFuturesOrder) {
        this.futuresOrders = [ ...this.futuresOrders, order ];
    }
}
