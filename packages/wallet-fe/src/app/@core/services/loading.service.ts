import { Injectable } from "@angular/core";
import { ToastrService } from "ngx-toastr";

type TLoadings = 'tradesLoading' | 'isLoading';

@Injectable({
    providedIn: 'root',
})

export class LoadingService {
    private _isLoading: boolean = false;
    private _tradesLoading: boolean = false;
    constructor(
        private toastrService: ToastrService,
    ) {}

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
        if(value === true) this._setMaxLoadingTime('tradesLoading', 100000);
        this._tradesLoading = value;
    }

    private _setMaxLoadingTime(loading: TLoadings, ms: number) {
        setTimeout(() => {
            if (this[loading] === true) {
                this[loading] = false;
                this.toastrService.warning(`Loading Warning`, "Warning");
            }
        }, ms);
    }
}
