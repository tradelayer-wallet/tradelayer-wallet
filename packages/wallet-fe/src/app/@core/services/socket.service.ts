import { Injectable } from "@angular/core";
import { Subject } from "rxjs";
import { Socket } from "socket.io-client";
import { io } from 'socket.io-client'
import { environment } from '../../../environments/environment';
import { LoadingService } from "./loading.service";

export enum SocketEmits {
    LTC_INSTANT_TRADE = 'LTC_INSTANT_TRADE',
    TOKEN_TOKEN_TRADE = 'TOKEN_TOKEN_TRADE',
}

@Injectable({
    providedIn: 'root',
})

export class SocketService {
    private _socket: Socket | null = null;

    constructor(
        private loadingService: LoadingService,
    ) {}

    private get socketServerUrl(): string {
        return environment.socketServerUrl;
    }

    get socket() {
        if (!this._socket) return this.socketConnect();
        return this._socket;
    }

    socketConnect() {
        this.loadingService.isLoading = true;
        this._socket = io(this.socketServerUrl, { reconnection: false, requestTimeout: 2000 });
        this.handleMainSocketEvents()
        return this._socket;
    }

    disconnect() {
        if (this.socket) {
            this.socket.disconnect();
        }
    };

    private handleMainSocketEvents() {
        if (this.socket) {
            this.socket.on('connect', () => this.loadingService.isLoading = false);
            this.socket.on('connect_error', () => this.loadingService.isLoading = false)
        }
    }
}
