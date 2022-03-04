import { Injectable } from "@angular/core";
import { Router } from "@angular/router";
import { ToastrService } from "ngx-toastr";
import { Socket } from "socket.io-client";
import { io } from 'socket.io-client'
import { environment } from '../../../environments/environment';
import { DialogService, DialogTypes } from "./dialogs.service";

export enum SocketEmits {
    LTC_INSTANT_TRADE = 'LTC_INSTANT_TRADE',
    TOKEN_TOKEN_TRADE = 'TOKEN_TOKEN_TRADE',
}

@Injectable({
    providedIn: 'root',
})

export class SocketService {
    private _socket: Socket | null = null;
    private _orderbookServerConnected: boolean = false;
    private _mainApiServerConnected: boolean = false;
    
    mainApiServerWaiting: boolean = false;
    orderbookServerWaiting: boolean = false;
    localServerWaiting: boolean = false;

    constructor(
        private toasterService: ToastrService,
        private router: Router,
        private dialogService: DialogService,
    ) {}

    private get socketServerUrl(): string {
        return environment.homeApiUrl;
    }

    get orderbookServerConnected() {
        return this._orderbookServerConnected;
    }

    get mainApiServerConnected() {
        return this._mainApiServerConnected;
    }

    get socket() {
        if (!this._socket) return this.socketConnect();
        return this._socket;
    }

    get serversWaiting(): boolean {
        return this.localServerWaiting || this.mainApiServerWaiting;
    }

    socketConnect() {
        this.localServerWaiting = true;
        this._socket = io(this.socketServerUrl, { reconnection: false });
        this.handleMainSocketEvents()
        return this._socket;
    }

    disconnect() {
        if (this.socket) {
            this.socket.disconnect();
        }
    };

    apiReconnect(url: string) {
        this.orderbookServerWaiting = true;
        this.socket.emit('api-reconnect', url);
    }

    disconenctOrderbook() {
        this.socket.emit('orderbook-disconnect');
    }

    api2Reconnect(isTestNet: boolean) {
        this.mainApiServerWaiting = true;
        this.socket.emit('api-2-reconnect', isTestNet);
    }

    private handleMainSocketEvents() {
        if (this.socket) {
            this.socket.on('need-update', ()=> {
                console.log('Wallet App Need To Be Updated!!');
                this.toasterService.info(
                    'The application need to be updated!',
                    'INFO', 
                    { extendedTimeOut: 2000, timeOut: 2000 },
                );
            });

            this.socket.on('connect', () => {
                console.log(`Connect to the local Server`);
                this.dialogService.closeAllDialogs();
                this.router.navigateByUrl('/');
                this.localServerWaiting = false;
            });

            this.socket.on('connect_error', () => {
                console.log(`Local Server Connection Error`);
                this.dialogService.closeAllDialogs();
                this.localServerWaiting = false;
            });

            this.socket.on('disconnect', () => {
                this.dialogService.closeAllDialogs();
                this.localServerWaiting = false;
                console.log(`Disconnected from the Local Server`);
            });

            this.socket.on('server_connect', () => {
                console.log(`Connect to the Orderbook Server`);
                this._orderbookServerConnected = true;
                this.orderbookServerWaiting = false;
            });

            this.socket.on('server_connect_error', () => {
                console.log(`Orderbook Server Connection Error`);
                this.toasterService.error('Orderbook Conenction Error', 'Error');
                this._orderbookServerConnected = false;
                this.orderbookServerWaiting = false;
            });

            this.socket.on('server_disconnect', () => {
                console.log(`Disconnected from the Orderbook Server`);
                this._orderbookServerConnected = false;
                this.orderbookServerWaiting = false;
            });

            this.socket.on('api_connect', () => {
                console.log(`API Server Connected`);
                this._mainApiServerConnected = true;
                this.mainApiServerWaiting = false;
            });

            this.socket.on('api_disconnect', () => {
                console.log(`Disconnected from the API Server`);
                this._mainApiServerConnected = false;
                this.mainApiServerWaiting = false;
            });

            this.socket.on('api_connect_error', () => {
                console.log(`API SERVER Connection Error`);
                this._mainApiServerConnected = false;
                this.mainApiServerWaiting = false;
            });

            this.socket.on('error_message', (message: string) => {
                this.toasterService.error(message || `Undefined Error`, 'Error');
            });

            this.socket.on('trade_error', (error: string) => {
                this.toasterService.error(error || `Undefined Error`, `Trade Error`);
            });

            this.socket.on('trade_success', (data: string) => {
                this.toasterService.success(data || `Unknown Data`, `Sucessfull Trade`);
            });
        }
    }
}
