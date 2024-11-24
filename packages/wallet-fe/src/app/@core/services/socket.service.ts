import { Injectable } from "@angular/core";
import { Router } from "@angular/router";
import { ToastrService } from "ngx-toastr";
import WebSocket from 'ws';  // Correct way to import WebSocket from 'ws'
import { environment } from '../../../environments/environment';
import { ApiService } from "./api.service";

export enum SocketEmits {
    LTC_INSTANT_TRADE = 'LTC_INSTANT_TRADE',
    TOKEN_TOKEN_TRADE = 'TOKEN_TOKEN_TRADE',
}
export const obEventPrefix = 'OB_SOCKET';

@Injectable({
    providedIn: 'root',
})

export class SocketService {
    private _socket: WebSocket | null = null;  // Use WebSocket directly here
    private _obSocketConnected: boolean = false;

    private mainSocketWaiting: boolean = false;
    private obServerWaiting: boolean = false;

    constructor(
        private toasterService: ToastrService,
        private router: Router,
        private apiService: ApiService,
    ) {}

    get socketsLoading() {
        return this.mainSocketWaiting || this.obServerWaiting;
    }

    private get mainSocketUrl(): string {
        return environment.homeApiUrl;
    }

    get obSocketConnected() {
        return this._obSocketConnected;
    }

    get socket() {
        if (!this._socket) return this.mainSocketConnect();
        return this._socket;
    }

    get marketApi() {
        return this.apiService.marketApi;
    }

    mainSocketConnect() {
        this.mainSocketWaiting = true;
        this._socket = new WebSocket(this.mainSocketUrl);  // Using WebSocket directly instead of Socket.IO
        this.handleMainSocketEvents();
        this.handleMainOBSocketEvents();
        return this._socket;
    }

    obSocketConnect(url: string) {
        this.obServerWaiting = true;
        this.socket.send(JSON.stringify({ type: 'ob-sockets-connect', url }));  // Use send for WebSocket
    }

    obSocketDisconnect() {
        this.socket.send(JSON.stringify({ type: 'ob-sockets-disconnect' }));  // Use send for WebSocket
    }

    private handleMainSocketEvents() {
        this.socket.onopen = () => {
            this.mainSocketWaiting = false;
        };
        this.socket.onerror = () => {
            this.mainSocketWaiting = false;
        };
        this.socket.onclose = () => {
            this.mainSocketWaiting = false;
        };
    }

    private handleMainOBSocketEvents() {
        this.socket.onmessage = (event: MessageEvent) => {
            const data = JSON.parse(event.data);
            switch (data.event) {
                case `${obEventPrefix}::connect`:
                    this._obSocketConnected = true;
                    this.obServerWaiting = false;
                    break;
                case `${obEventPrefix}::connect_error`:
                    this._obSocketConnected = false;
                    this.obServerWaiting = false;
                    this.toasterService.error('Orderbook Connection Error, Host is probably down', 'Error');
                    break;
                case `${obEventPrefix}::disconnect`:
                    this._obSocketConnected = false;
                    this.obServerWaiting = false;
                    this.router.navigateByUrl('/');
                    this.toasterService.error('Orderbook Disconnected', 'Error');
                    break;
                default:
                    break;
            }
        };
    }
}
