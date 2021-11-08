
import { Injectable } from "@angular/core";
const electron = (<any>window).require('electron')

@Injectable({
    providedIn: 'root',
})

export class ElectronService {
    private _ipcRenderer: any;

    constructor() {
        this._ipcRenderer = electron.ipcRenderer;
        this.handleEvents();
    }

    get ipcRenderer() {
        return this._ipcRenderer;
    };

    private handleEvents() {
        // this.ipcRenderer.on('angular-electron-message', (_: any, message: any) => {
        //     const { event, data } = message;
        //     console.log(`event: ${event}, data: ${data}`);
        // });
    }

    emitEvent(event: string, data?: any) {
        this.ipcRenderer.send('angular-electron-message', { event, data });
    }
}
