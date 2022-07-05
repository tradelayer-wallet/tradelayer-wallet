import { AppImageUpdater, NsisUpdater, MacUpdater } from 'electron-updater';
import { ElectronApp } from './electron-builder';

export class AutoUpdater {
    private autoUpdater: NsisUpdater | MacUpdater | AppImageUpdater;
    private electronApp: ElectronApp;

    constructor(app: ElectronApp) {
        this.electronApp = app;
        this.initAutoUpdater();
        this.handleEvents();
        this.check();
    }

    initAutoUpdater() {
        this.autoUpdater = process.platform === "win32"
        ? new NsisUpdater()
        : process.platform === "darwin"
            ? new MacUpdater()
            : process.platform === "linux"
                ? new AppImageUpdater()
                : null;

        if (!this.autoUpdater) return;
        this.autoUpdater.autoDownload = false;
        this.autoUpdater.setFeedURL({
            owner: "valiopld",
            repo: 'tradelayer-wallet',
            provider: 'github',
            user: 'valiopld',
        });
    }

    handleEvents() {
        if (!this.autoUpdater) return;
        const e = 'update-app';
        this.autoUpdater.on("error", (error) => this.electronApp.sendMessageToAngular(e, { state: 1, data: error }));
        this.autoUpdater.on("checking-for-update", (data) => this.electronApp.sendMessageToAngular(e, { state: 2, data }));
        this.autoUpdater.on("update-not-available", () => this.electronApp.sendMessageToAngular(e, { state: 3, data: null }));
        this.autoUpdater.on("update-available", () => this.electronApp.sendMessageToAngular(e, { state: 4, data: null }));
        this.autoUpdater.on("download-progress", () => this.electronApp.sendMessageToAngular(e, { state: 5, data: null }));
        this.autoUpdater.on("update-downloaded", () => {
            this.electronApp.sendMessageToAngular(e, { state: 6, data: null });
            this.autoUpdater.quitAndInstall(true, true);
        });
    }

    async download() {
        this.autoUpdater.downloadUpdate();
    }

    async check() {
        this.autoUpdater.checkForUpdates();
    }
}