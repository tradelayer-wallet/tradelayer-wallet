import { Injectable } from "@angular/core";

type TLoadings = 'tradesLoading' | 'isLoading';

@Injectable({
    providedIn: 'root',
})

export class LoadingService {
    private _isLoading: boolean = false;
    private _tradesLoading: boolean = false;
    constructor() {}

    get isLoading(): boolean {
        return this._isLoading;
    }

    set isLoading(value: boolean) {
        this._isLoading = value;
    }

    get tradesLoading(): boolean {
        return this._tradesLoading;
    }

    set tradesLoading(value: boolean) {
        if(value === true) this._setMaxLoadingTime('tradesLoading', 10000);
        this._tradesLoading = value;
    }

    private _setMaxLoadingTime(loading: TLoadings, ms: number) {
        setTimeout(() => this[loading] = false, ms);
    }
}
