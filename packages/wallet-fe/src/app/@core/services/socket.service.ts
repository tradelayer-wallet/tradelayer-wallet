import { Injectable } from "@angular/core";
import { Subject } from 'rxjs';
import { environment } from '../../../environments/environment';
import { ApiService } from "./api.service";
import { ToastrService } from "ngx-toastr";
import { Router } from "@angular/router";

export const obEventPrefix = 'OB_SOCKET';

@Injectable({
  providedIn: 'root',
})
export class SocketService {
  private _socket: WebSocket | null = null;
  private _obSocketConnected: boolean = false;
  

  private mainSocketWaiting: boolean = false;
  private obServerWaiting: boolean = false;

  // Event dispatcher
  private eventSubject = new Subject<any>();

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

  get socket(): WebSocket {
    if (!this._socket) return this.mainSocketConnect();
    return this._socket;
  }

  get marketApi() {
    return this.apiService.marketApi;
  }

  mainSocketConnect() {
    this.mainSocketWaiting = true;
    this._socket = new WebSocket(this.mainSocketUrl);
    this.handleMainSocketEvents();
    this.handleMainOBSocketEvents();
    return this._socket;
  }

  obSocketConnect(url: string) {
    this.obServerWaiting = true;
    this.socket.send(JSON.stringify({ type: 'ob-sockets-connect', url }));
  }

  obSocketDisconnect() {
    this.socket.send(JSON.stringify({ type: 'ob-sockets-disconnect' }));
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
      let data: any;

      if (typeof event.data === 'string') {
        try {
          data = JSON.parse(event.data);
        } catch (e) {
          console.error('Error parsing JSON data:', e);
          return;
        }
      } else if (event.data instanceof ArrayBuffer) {
        const decoder = new TextDecoder();
        const text = decoder.decode(event.data);
        try {
          data = JSON.parse(text);
        } catch (e) {
          console.error('Error parsing JSON data:', e);
          return;
        }
      } else {
        console.error('Unsupported data type:', typeof event.data);
        return;
      }

      // Emit the event using the Subject
      this.eventSubject.next(data);

      // Handle specific events if necessary
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
          // Other events are handled by subscribers
          break;
      }
    };
  }

  // Method to get the event Subject as Observable
  get events$() {
    return this.eventSubject.asObservable();
  }
}
