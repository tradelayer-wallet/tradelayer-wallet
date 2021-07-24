import { Component } from '@angular/core';

import { SocketService } from './@core/services/socket.service';
import { LoadingService } from './@core/services/loading.service';

@Component({
  selector: 'tl-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss']
})
export class AppComponent {
  constructor(
    private socketService: SocketService,
    private loadingService: LoadingService
  ) {}

  get isLoading(): boolean {
    return this.loadingService.isLoading;
  }

  get serverConnected() {
    return this.socketService.socket?.connected;
  }
}
