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
export const obEventPrefix = 'OB_SOCKET';

@Injectable({
    providedIn: 'root',
})

export class SocketService {
    private _socket: Socket | null = null;
    private _obSocketConnected: boolean = false;

    private mainSocketWaiting: boolean = false;
    private obServerWaiting: boolean = false;

    constructor(
        private toasterService: ToastrService,
        private router: Router,
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

    mainSocketConnect() {
        this.mainSocketWaiting = true;
        this._socket = io(this.mainSocketUrl, { reconnection: false });
        this.handleMainSocketEvents();
        this.handleMainOBSocketEvents();
        return this._socket;
    }

   obSocketConnect(url: string) {
        this.obServerWaiting = true;
        this.socket.emit('ob-sockets-connect', url);
    }

    obSocketDisconnect() {
        this.socket.emit('ob-sockets-disconnect');
    }

    private handleMainSocketEvents() {
            this.socket.on('connect', () => this.mainSocketWaiting = false);
            this.socket.on('connect_error', () => this.mainSocketWaiting = false);
            this.socket.on('disconnect', () => this.mainSocketWaiting = false);
    }

    private handleMainOBSocketEvents() {
        this.socket.on(`${obEventPrefix}::connect`, () => {
            this._obSocketConnected = true;
            this.obServerWaiting = false;
        });

        this.socket.on(`${obEventPrefix}::connect_error`, () => {
            this._obSocketConnected = false;
            this.obServerWaiting = false;
            this.toasterService.error('Orderbook Conenction Error', 'Error');
        });

        this.socket.on(`${obEventPrefix}::disconnect`, () => {
            this._obSocketConnected = false;
            this.obServerWaiting = false;
            this.router.navigateByUrl('/');
            this.toasterService.error('Orderbook Conenction Error', 'Error');
        });
    }
}
