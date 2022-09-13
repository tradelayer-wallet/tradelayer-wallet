
import { Injectable } from "@angular/core";
import { LoadingService } from "./loading.service";
const electron = (<any>window).require('electron');

@Injectable({
    providedIn: 'root',
})

export class ElectronService {
    private _ipcRenderer: any;

    constructor() {
        this._ipcRenderer = electron.ipcRenderer;
    }

    get ipcRenderer() {
        return this._ipcRenderer;
    };

    emitEvent(event: string, data?: any) {
        this.ipcRenderer.send('angular-electron-message', { event, data });
    }
}
