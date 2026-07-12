import { Injectable, OnDestroy } from "@angular/core";
import { Router } from "@angular/router";
import { ToastrService } from "ngx-toastr";
import { Socket } from "socket.io-client";
import { io } from 'socket.io-client'
import { environment } from '../../../environments/environment';
import { ApiService } from "./api.service";
import { Subject, fromEvent, Observable } from 'rxjs';
import { takeUntil, share, shareReplay } from 'rxjs/operators';
import { ElectronService } from "./electron.service";

export enum SocketEmits {
    LTC_INSTANT_TRADE = 'LTC_INSTANT_TRADE',
    TOKEN_TOKEN_TRADE = 'TOKEN_TOKEN_TRADE',
}
export const obEventPrefix = 'OB_SOCKET';

@Injectable({
    providedIn: 'root',
})
export class SocketService implements OnDestroy {
    private _socket: Socket | null = null;
    private _obSocketConnected: boolean = false;
    private hyperExpressId: string = ''
    private mainSocketWaiting: boolean = false;
    private obServerWaiting: boolean = false;
    private obConnectionTimeout: ReturnType<typeof setTimeout> | null = null;
    private readonly obConnectionTimeoutMs = 15000;
    
    // === NEW: Centralized event streams (share across subscribers) ===
    private destroy$ = new Subject<void>();
    private eventStreams = new Map<string, Observable<any>>();

    constructor(
        private toasterService: ToastrService,
        private router: Router,
        private apiService: ApiService,
        private electronService: ElectronService,
    ) {}

    ngOnDestroy() {
        this.destroy$.next();
        this.destroy$.complete();
        this.eventStreams.clear();
        this.clearObConnectionTimeout();
        if (this._socket) {
            this._socket.disconnect();
            this._socket = null;
        }
    }

    get socketsLoading() {
        return this.mainSocketWaiting || this.obServerWaiting;
    }

    get socketId(){
        return this.hyperExpressId
    }

    set socketId(id: string){
        this.hyperExpressId = id
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

    /**
     * NEW: Get a shared observable for a socket event.
     * This prevents listener accumulation - multiple subscribers share ONE listener.
     */
    fromEvent$<T = any>(event: string): Observable<T> {
        if (!this.eventStreams.has(event)) {
            const stream$ = new Observable<T>(observer => {
                const handler = (data: T) => observer.next(data);
                this.socket.on(event, handler);
                return () => {
                    this.socket.off(event, handler);
                };
            }).pipe(
                takeUntil(this.destroy$),
                shareReplay({ bufferSize: 1, refCount: true })
            );
            this.eventStreams.set(event, stream$);
        }
        return this.eventStreams.get(event)!;
    }

    /**
     * NEW: Clean up a specific event stream (call on market switch)
     */
    clearEventStream(event: string) {
        this.eventStreams.delete(event);
    }

    mainSocketConnect() {
        this.mainSocketWaiting = true;
        const authToken = this.electronService.getLocalApiToken();
        const query = authToken ? { tl_auth: authToken } : undefined;
        this._socket = io(this.mainSocketUrl, { reconnection: false, query });
        this.handleMainSocketEvents();
        this.handleMainOBSocketEvents();
        return this._socket;
    }

    obSocketConnect(url: string) {
        const normalizedUrl = (url || '').trim();
        if (!normalizedUrl) {
            this._obSocketConnected = false;
            this.obServerWaiting = false;
            this.toasterService.error('Orderbook server URL is required', 'Error');
            return;
        }

        this.obServerWaiting = true;
        this.clearObConnectionTimeout();
        this.obConnectionTimeout = setTimeout(() => {
            if (!this.obServerWaiting) return;
            this.obServerWaiting = false;
            this._obSocketConnected = false;
            this.toasterService.error('Orderbook connection timed out', 'Error');
        }, this.obConnectionTimeoutMs);

        this.socket.emit('ob-sockets-connect', normalizedUrl);
    }

    obSocketDisconnect() {
        this.clearObConnectionTimeout();
        this.obServerWaiting = false;
        this.socket.emit('ob-sockets-disconnect');
    }

    private clearObConnectionTimeout() {
        if (this.obConnectionTimeout) {
            clearTimeout(this.obConnectionTimeout);
            this.obConnectionTimeout = null;
        }
    }

    private handleMainSocketEvents() {
        this.socket.on('connect', () => this.mainSocketWaiting = false);
        this.socket.on('connect_error', () => this.mainSocketWaiting = false);
        this.socket.on('disconnect', () => this.mainSocketWaiting = false);
    }

    private handleMainOBSocketEvents() {
        this.socket.on(`${obEventPrefix}::connect`, (data) => {
            this.clearObConnectionTimeout();
            this._obSocketConnected = true;
            this.obServerWaiting = false;
            this.socketId = data.id
        });

        this.socket.on(`${obEventPrefix}::connected`, (data) => {
            this.clearObConnectionTimeout();
            this._obSocketConnected = true;
            this.obServerWaiting = false;
            console.log('connected fired 0'+JSON.stringify(data))
            this.socketId = data.id
        });

        this.socket.on(`${obEventPrefix}::connect_error`, () => {
            this.clearObConnectionTimeout();
            this._obSocketConnected = false;
            this.obServerWaiting = false;
            this.toasterService.error('Orderbook Connection Error, Host is probably down', 'Error');
        });

        this.socket.on(`${obEventPrefix}::disconnect`, () => {
            if (!this._obSocketConnected && !this.obServerWaiting) return;
            this.clearObConnectionTimeout();
            this._obSocketConnected = false;
            this.obServerWaiting = false;
            this.router.navigateByUrl('/');
            this.socketId= ''
            this.toasterService.error('Orderbook Disconnected', 'Error');
        });
    }
}
