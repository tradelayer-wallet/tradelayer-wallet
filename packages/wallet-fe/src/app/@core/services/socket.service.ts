import { Injectable } from "@angular/core";
import { ToastrService } from "ngx-toastr";
import { Subject } from "rxjs";
import { Socket } from "socket.io-client";
import { io } from 'socket.io-client'
import { environment } from '../../../environments/environment';

export enum SocketEmits {
    LTC_INSTANT_TRADE = 'LTC_INSTANT_TRADE',
    TOKEN_TOKEN_TRADE = 'TOKEN_TOKEN_TRADE',
}

@Injectable({
    providedIn: 'root',
})

export class SocketService {
    private _socket: Socket | null = null;
    private _apiServerConnected: boolean = false;

    apiServerWaiting: boolean = true;
    localServerWaiting: boolean = true;

    constructor(
        private toasterService: ToastrService,
    ) {}

    private get socketServerUrl(): string {
        return environment.homeApiUrl;
    }

    get apiServerConnected() {
        return this._apiServerConnected;
    }

    get socket() {
        if (!this._socket) return this.socketConnect();
        return this._socket;
    }

    get serversWaiting(): boolean {
        return this.apiServerWaiting || this.localServerWaiting;
    }

    socketConnect() {
        this.localServerWaiting = true;
        this._socket = io(this.socketServerUrl, { reconnectionAttempts: 2 });
        this.handleMainSocketEvents()
        return this._socket;
    }

    disconnect() {
        if (this.socket) {
            this.socket.disconnect();
        }
    };

    apiReconnect() {
        this.apiServerWaiting = true;
        this.socket.emit('api-recoonect');
    }

    private handleMainSocketEvents() {
        if (this.socket) {
            this.socket.on('connect', () => {
                console.log(`Connect to the local Server`);
                this.localServerWaiting = false;
            });

            this.socket.on('connect_error', () => {
                console.log(`Local Server Connection Error`);
                this.localServerWaiting = false;
            });

            this.socket.on('disconnect', () => {
                console.log(`Disconnected from the Local Server`);
            });

            this.socket.on('server_connect', () => {
                console.log(`Connect to the API Server`);
                this._apiServerConnected = true;
                this.apiServerWaiting = false;
            });

            this.socket.on('server_connect_error', () => {
                console.log(`API Server Connection Error`);
                this._apiServerConnected = false;
                this.apiServerWaiting = false;
            });

            this.socket.on('server_disconnect', () => {
                console.log(`Disconnected from the API Server`);
                this._apiServerConnected = false;
            });

            this.socket.on('error_message', (message: string) => {
                this.toasterService.error(message || `Undefined Error`, 'Error');
            });

            this.socket.on('opened-positions', (openedPositions: any[]) => {
                console.log(openedPositions);
            });

            this.socket.on('trade_error', (error: string) => {
                this.toasterService.error(error || `Undefined Error`, `Trade Error`);
            });

            this.socket.on('trade_error', (data: string) => {
                this.toasterService.success(data || `Unknown Data`, `Sucessfull Trade`);
            });
        }
    }
}
