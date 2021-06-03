import { Injectable } from "@angular/core";
import { Socket } from "socket.io-client";
import { io } from 'socket.io-client'
import { environment } from '../../../environments/environment';

export enum SocketEmits {
    LTC_INSTANT_TRADE = 'LTC_INSTANT_TRADE',
}

@Injectable({
    providedIn: 'root',
})

export class SocketService {
    private _socket: Socket | null = null;

    constructor() {}

    private get socketServerUrl(): string {
        return environment.socketServerUrl;
    }

    get socket() {
        if (!this._socket) this._socket = io(this.socketServerUrl); 
        return this._socket
    }

    socketConnect() {
        this._socket = io(this.socketServerUrl);
        
        this.dataFeedSubscriber();
    }

    disconnect() {
        if (this.socket) {
            this.socket.disconnect();
        }
    };

    private dataFeedSubscriber() {
        this._socket?.on('dataFeed', (data) => {
            console.log(data)
        })
    }
}
