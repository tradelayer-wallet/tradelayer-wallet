import { Injectable } from "@angular/core";
import { SyncNodeDialog } from "src/app/@shared/dialogs/sync-node/sync-node.component";

export const windowComponents = {
    SYNC_WINDOW: SyncNodeDialog,
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
    _tabs: IWindow[] = [
        {
            component: windowComponents.SYNC_WINDOW,
            minimized: false,
            title: 'Synchronization'
        },
    ];
    constructor() { }

    get tabs() {
        return this._tabs;
    }

    set tabs(tabs: IWindow[]) {
        this._tabs = tabs;
    }
}
