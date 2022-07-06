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
    // private _orderbookServerConnected: boolean = false;
    // private _mainApiServerConnected: boolean = false;
    
    // mainApiServerWaiting: boolean = false;
    // orderbookServerWaiting: boolean = false;
    // localServerWaiting: boolean = false;

    constructor(
        // private toasterService: ToastrService,
        // private router: Router,
        private dialogService: DialogService,
    ) {}

    private get socketServerUrl(): string {
        return environment.homeApiUrl;
    }

    // get orderbookServerConnected() {
    //     return this._orderbookServerConnected;
    // }

    // get mainApiServerConnected() {
    //     return this._mainApiServerConnected;
    // }

    get socket() {
        if (!this._socket) return this.socketConnect();
        return this._socket;
    }

    // get serversWaiting(): boolean {
    //     return this.localServerWaiting || this.mainApiServerWaiting;
    // }

    socketConnect() {
        // this.localServerWaiting = true;
        this._socket = io(this.socketServerUrl, { reconnection: false });
        this.handleMainSocketEvents();
        return this._socket;
    }

    disconnect() {
        if (this.socket) {
            this.socket.disconnect();
        }
    };

    // orderbookServerReconnect(url: string) {
    //     this.orderbookServerWaiting = true;
    //     this.socket.emit('orderbook-server-reconnect', url);
    // }

    // disconenctOrderbook() {
    //     this.socket.emit('orderbook-server-disconnect');
    // }

    // apiServerReconnect(isTestNet: boolean) {
    //     this.mainApiServerWaiting = true;
    //     this.socket.emit('api-server-reconnect', isTestNet);
    // }

    private handleMainSocketEvents() {
        if (this.socket) {
            this.handleMainWalletSockets();
            // this.handleMainApiSockets();
            // this.handleMainOBSockets();
        }
    }

    private handleMainWalletSockets() {
            // this.socket.on('connect', () => {
            //     this.dialogService.closeAllDialogs();
            //     // this.router.navigateByUrl('/');
            //     // this.localServerWaiting = false;
            // });

            // this.socket.on('connect_error', () => {
            //     this.dialogService.closeAllDialogs();
            //     // this.localServerWaiting = false;
            // });

            // this.socket.on('disconnect', () => {
            //     this.dialogService.closeAllDialogs();
            //     // this.localServerWaiting = false;
            // });
    }

    // private handleMainApiSockets() {
    //     this.socket.on('API::connect', () => {
    //         this._mainApiServerConnected = true;
    //         this.mainApiServerWaiting = false;
    //     });

    //     this.socket.on('API::need-update', ()=> {
    //         this.toasterService.info(
    //             'The application need to be updated!',
    //             'INFO', 
    //             { extendedTimeOut: 2000, timeOut: 2000 },
    //         );
    //     });

    //     this.socket.on('API::disconnect', () => {
    //         this._mainApiServerConnected = false;
    //         this.mainApiServerWaiting = false;
    //     });

    //     this.socket.on('API::connect_error', () => {
    //         this._mainApiServerConnected = false;
    //         this.mainApiServerWaiting = false;
    //     });
    // }

    // private handleMainOBSockets() {
    //     this.socket.on('OBSERVER::connect', () => {
    //         this._orderbookServerConnected = true;
    //         this.orderbookServerWaiting = false;
    //     });

    //     this.socket.on('OBSERVER::connect_error', () => {
    //         this.toasterService.error('Orderbook Conenction Error', 'Error');
    //         this._orderbookServerConnected = false;
    //         this.orderbookServerWaiting = false;
    //     });

    //     this.socket.on('OBSERVER::disconnect', () => {
    //         this._orderbookServerConnected = false;
    //         this.orderbookServerWaiting = false;
    //         this.router.navigateByUrl('/');
    //         this.toasterService.error('Orderbook Conenction Error', 'Error');
    //     });
    // }
}
