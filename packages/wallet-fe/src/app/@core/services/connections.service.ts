import { Injectable } from "@angular/core";
import { Subject } from "rxjs";

interface IConnectionsTypes {
    isOnline: boolean;
};

@Injectable({
    providedIn: 'root',
})

export class ConnectionService {
    private _isOnline: boolean = window.navigator.onLine;
    public isOnline$: Subject<boolean> = new Subject();

    constructor() {
        this.runHandlers();
    }

    get isOnline() {
        return this._isOnline;
    }

    set isOnline(isOnline: boolean) {
        this._isOnline = isOnline;
        this.isOnline$.next(isOnline);
    }

    private runHandlers() {
        window.onoffline = () => this.isOnline = false;
        window.ononline = () => this.isOnline = true;
    }
}