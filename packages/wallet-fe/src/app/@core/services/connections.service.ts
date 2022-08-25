import { Injectable } from "@angular/core";
import { Subject } from "rxjs";
import { SocketService } from "./socket.service";

interface IConnectionsTypes {
    isOnline: boolean;
};

@Injectable({
    providedIn: 'root',
})

export class ConnectionService {
    private _isOnline: boolean = window.navigator.onLine;
    public isOnline$: Subject<boolean> = new Subject();

    constructor(
        private socketService: SocketService,
    ) { }

    get isOnline() {
        return this._isOnline;
    }

    get isMainSocketConnected() {
        return this.socketService.socket.connected;
    }

    get isOBSocketConnected() {
        return this.socketService.obSocketConnected;
    }

    set isOnline(isOnline: boolean) {
        this._isOnline = isOnline;
        this.isOnline$.next(isOnline);
    }

    onInit() {
        window.onoffline = () => this.isOnline = false;
        window.ononline = () => this.isOnline = true;
    }
}