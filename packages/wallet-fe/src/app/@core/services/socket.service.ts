import { Injectable } from "@angular/core";
import { Router } from "@angular/router";
import { ToastrService } from "ngx-toastr";
import { Socket } from "socket.io-client";
import { io } from 'socket.io-client'
import { environment } from '../../../environments/environment';
import { ApiService } from "./api.service";

export enum SocketEmits {
    LTC_INSTANT_TRADE = 'LTC_INSTANT_TRADE',
    TOKEN_TOKEN_TRADE = 'TOKEN_TOKEN_TRADE',
}
export const obEventPrefix = 'OB_SOCKET';

/** Reconnect backoff of the main socket: first retry after ~250 ms, then doubling up to 10 s, forever. */
export const MAIN_SOCKET_RECONNECT = {
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 250,
    reconnectionDelayMax: 10000,
    randomizationFactor: 0.5,
    timeout: 10000,
};
/** The watchdog looks at the clock this often; a gap of GAP_MS means the page was suspended. */
const WATCHDOG_MS = 5000;
const WATCHDOG_GAP_MS = 15000;
/** After a reconnect, how long to wait for the wallet service to report the orderbook before asking again. */
const OB_RESYNC_MS = 3000;
/** A resync that failed (the network may be down right after a resume) is tried again after this long. */
const OB_RESYNC_RETRY_MS = 10000;

@Injectable({
    providedIn: 'root',
})

export class SocketService {
    private _socket: Socket | null = null;
    private _obSocketConnected: boolean = false;
    /** The orderbook the user connected to; cleared by a deliberate disconnect or a refused connection. */
    private _obUrl: string | null = null;
    /** An OB_SOCKET event arrived since the main socket last reconnected. */
    private _obEventSinceReconnect: boolean = false;
    /** The orderbook connection being requested is a resync, not the user's own request. */
    private _obResyncing: boolean = false;
    private _mainConnectedBefore: boolean = false;
    private _watchdogStarted: boolean = false;

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
        if (this._socket) {
            // The socket and its listeners stay; only the connection is opened again.
            if (!this._socket.connected) {
                this.mainSocketWaiting = true;
                this._socket.connect();
            }
            return this._socket;
        }
        this.mainSocketWaiting = true;
        this._socket = io(this.mainSocketUrl, MAIN_SOCKET_RECONNECT);
        this.handleMainSocketEvents();
        this.handleMainOBSocketEvents();
        this.startWatchdog();
        return this._socket;
    }

    /**
     * Bring the main socket back now: open it if it is down; with `suspected` (the page or the
     * machine was suspended) also drop a connection that still looks open, because its transport
     * may be dead, and let socket.io reconnect.
     */
    reconnectNow(suspected: boolean = false) {
        const socket = this._socket;
        if (!socket) return;
        if (!socket.connected) {
            socket.connect();
        } else if (suspected) {
            const engine = (socket.io as any).engine;
            if (engine && typeof engine.close === 'function') engine.close();
        }
    }

   obSocketConnect(url: string) {
        this.obServerWaiting = true;
        this._obUrl = url;
        this._obResyncing = false;
        this.socket.emit('ob-sockets-connect', url);
    }

    obSocketDisconnect() {
        this._obUrl = null;
        this._obResyncing = false;
        this.socket.emit('ob-sockets-disconnect');
    }

    private handleMainSocketEvents() {
            this.socket.on('connect', () => {
                this.mainSocketWaiting = false;
                this.onMainSocketConnected();
            });
            this.socket.on('connect_error', () => this.mainSocketWaiting = false);
            this.socket.on('disconnect', (reason: string) => {
                this.mainSocketWaiting = false;
                // socket.io does not reconnect after a disconnect the server asked for.
                if (reason === 'io server disconnect') setTimeout(() => this.reconnectNow(), 500);
            });
    }

    /**
     * A reconnect gets a new session on the wallet service. Listeners stay on the socket. The
     * service hands the orderbook relay of the old session to the new one and reports its state;
     * if it reports nothing the relay is gone, and the connection is requested again.
     */
    private onMainSocketConnected() {
        const reconnected = this._mainConnectedBefore;
        this._mainConnectedBefore = true;
        if (!reconnected) return;
        this._obEventSinceReconnect = false;
        if (!this._obUrl) return;
        setTimeout(() => {
            if (!this._obEventSinceReconnect) this.obResync();
        }, OB_RESYNC_MS);
    }

    /** Ask the wallet service for the orderbook connection again (it replaces any client it has). */
    private obResync() {
        const socket = this._socket;
        if (!this._obUrl || !socket || !socket.connected) return;
        this._obResyncing = true;
        this.obServerWaiting = true;
        socket.emit('ob-sockets-connect', this._obUrl);
    }

    private startWatchdog() {
        if (this._watchdogStarted) return;
        this._watchdogStarted = true;
        let last = Date.now();
        setInterval(() => {
            const now = Date.now();
            const gap = now - last;
            last = now;
            if (gap > WATCHDOG_GAP_MS) this.reconnectNow(true);
            else this.reconnectNow();
        }, WATCHDOG_MS);
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) this.reconnectNow();
        });
    }

    private handleMainOBSocketEvents() {
        this.socket.on(`${obEventPrefix}::connect`, () => {
            this._obEventSinceReconnect = true;
            this._obResyncing = false;
            this._obSocketConnected = true;
            this.obServerWaiting = false;
        });

        this.socket.on(`${obEventPrefix}::connect_error`, () => {
            this._obEventSinceReconnect = true;
            if (this._obResyncing && this._obUrl) {
                // Our own resync could not reach the server (the network may still be coming
                // back): stay quiet and try again.
                this.obServerWaiting = false;
                setTimeout(() => { if (this._obResyncing) this.obResync(); }, OB_RESYNC_RETRY_MS);
                return;
            }
            this._obUrl = null;
            this._obSocketConnected = false;
            this.obServerWaiting = false;
            this.toasterService.error('Orderbook Conenction Error', 'Error');
        });

        this.socket.on(`${obEventPrefix}::disconnect`, () => {
            this._obEventSinceReconnect = true;
            this._obSocketConnected = false;
            this.obServerWaiting = false;
            this.router.navigateByUrl('/');
            this.toasterService.error('Orderbook Disconnected', 'Error');
        });
    }
}
