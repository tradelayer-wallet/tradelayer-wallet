import { Injectable } from "@angular/core";
import { OrderbookServerDialog } from "src/app/@shared/dialogs/orderbook-server/orderbook-server.component";
import { SyncNodeDialog } from "src/app/@shared/dialogs/sync-node/sync-node.component";
import { TerminalDialog } from "src/app/@shared/dialogs/terminal/terminal.component";

export const windowComponents = {
    SYNC_WINDOW: SyncNodeDialog,
    TERMINAL: TerminalDialog,
    ORDERBOOK_SERVER: OrderbookServerDialog,
};

export interface IWindow {
    component: any,
    minimized: boolean,
    title: string,
}

@Injectable({
    providedIn: 'root',
})

export class WindowsService {
    private _tabs: IWindow[] = [
        {
            component: windowComponents.SYNC_WINDOW,
            minimized: true,
            title: 'Synchronization'
        },
        {
            component: windowComponents.ORDERBOOK_SERVER,
            minimized: true,
            title: 'Orderbook Server'
        },
    ];
    constructor() { }

    get tabs() {
        return this._tabs;
    }

    set tabs(tabs: IWindow[]) {
        this._tabs = tabs;
    }

    openTerminal() {
        const terminal = this.tabs.find(e => e.title === 'RPC Terminal');
        if (terminal) {
            terminal.minimized = false;
        } else {
            const newTab: IWindow = {
                component: windowComponents.TERMINAL, 
                minimized: false, 
                title: 'RPC Terminal',
            };
            this.tabs = [...this.tabs, newTab];
        }
    }

    closeTab(title: string) {
        this.tabs = this.tabs.filter(e => e.title !== title);
    }
    
    toggleTab(tab: IWindow, value?: boolean) {
        tab.minimized = value || !tab.minimized;
    }
}
