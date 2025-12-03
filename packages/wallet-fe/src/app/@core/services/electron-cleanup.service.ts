/**
 * Add this to your Electron renderer bootstrap or app.component.ts
 * This ensures socket listeners are cleaned up before Electron reloads
 */

import { Injectable, OnDestroy, NgZone } from '@angular/core';
import { SocketService } from './@core/services/socket.service';
import { SpotOrderbookService } from './@core/services/spot-services/spot-orderbook.service';
import { FuturesOrderbookService } from './@core/services/futures-services/futures-orderbook.service';

@Injectable({ providedIn: 'root' })
export class ElectronCleanupService implements OnDestroy {
    private cleanupHandler: (() => void) | null = null;

    constructor(
        private ngZone: NgZone,
        private socketService: SocketService,
        private spotOrderbookService: SpotOrderbookService,
        private futuresOrderbookService: FuturesOrderbookService,
    ) {
        this.setupCleanupHandler();
    }

    private setupCleanupHandler() {
        // Run outside Angular zone to avoid CD during unload
        this.ngZone.runOutsideAngular(() => {
            this.cleanupHandler = () => {
                console.log('[Electron] beforeunload - cleaning up socket listeners');
                
                // End all orderbook subscriptions
                this.spotOrderbookService.endOrderbookSubscription();
                this.futuresOrderbookService.endOrderbookSubscription();
                
                // If socket service has cleanup method
                if ('ngOnDestroy' in this.socketService) {
                    (this.socketService as any).ngOnDestroy();
                }
            };

            window.addEventListener('beforeunload', this.cleanupHandler);
        });
    }

    ngOnDestroy() {
        if (this.cleanupHandler) {
            window.removeEventListener('beforeunload', this.cleanupHandler);
            this.cleanupHandler = null;
        }
    }
}

/**
 * USAGE: Add to your AppModule providers and inject in AppComponent constructor:
 * 
 * // app.module.ts
 * providers: [ElectronCleanupService, ...]
 * 
 * // app.component.ts
 * constructor(private electronCleanup: ElectronCleanupService) {}
 */
