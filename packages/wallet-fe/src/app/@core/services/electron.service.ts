import { Injectable } from "@angular/core";

export type ElectronMessage = {
    event: string;
    data?: unknown;
};

type ElectronBridge = {
    emitEvent: (event: string, data?: unknown) => void;
    getLocalApiToken: () => string;
    onMessage: (listener: (message: ElectronMessage) => void) => (() => void);
    onceMessage: (listener: (message: ElectronMessage) => void) => (() => void);
};

@Injectable({
    providedIn: 'root',
})

export class ElectronService {
    private bridge: ElectronBridge | null = (window as any).tradelayerElectron || null;
    private localApiToken: string | null = this.bridge?.getLocalApiToken?.() || null;

    get isAvailable() {
        return !!this.bridge;
    }

    getLocalApiToken() {
        return this.localApiToken;
    }

    emitEvent(event: string, data?: unknown) {
        this.bridge?.emitEvent(event, data);
    }

    onMessage(listener: (message: ElectronMessage) => void) {
        if (!this.bridge) {
            return () => undefined;
        }
        return this.bridge.onMessage(listener);
    }

    onceMessage(listener: (message: ElectronMessage) => void) {
        if (!this.bridge) {
            return () => undefined;
        }
        return this.bridge.onceMessage(listener);
    }
}
