import { App, app, BrowserWindow, globalShortcut } from 'electron';
import { ChildProcess, fork } from 'child_process';
import * as url from 'url';
import * as path from 'path';

class ElectronApp {
    private app: App;
    private mainWindow: BrowserWindow | null = null;
    private serverProcess: ChildProcess;

    constructor(app: App) {
        this.app = app;
        this.handleOnEvents();
        this.disableSecurityWarnings();
        this.serverProcess = fork(path.join(__dirname, './server/index.js'), ['args'], {
            stdio: ['pipe', 'pipe', 'pipe', 'ipc']
        });

        this.serverProcess.on("message", (message: any) => console.log({message}));
        this.serverProcess.send('init');
    }

    private handleOnEvents() {
        this.app.on('ready', () => this.createWindow());

        this.app.on('window-all-closed', async () => {
            // if (process.platform !== 'darwin') app.quit();
            if (this.serverProcess.connected) this.serverProcess.send('stop');
            await new Promise(res => setTimeout(() => res(true), 500));
            app.quit();
        });

        this.app.on('activate', () => {
            if (!this.mainWindow) this.createWindow();
        });

        this.app.on('browser-window-focus', function () {
            globalShortcut.register("CommandOrControl+R", () => console.log("ctrl+R Shortcut Disabled"));
            globalShortcut.register("F5", () => console.log("F5 Disabled"));
        });

        this.app.on('browser-window-blur', function () {
            globalShortcut.unregister('CommandOrControl+R');
            globalShortcut.unregister('F5');
        });
    }

    private handleMainWindowEvents() {
        if (!this.mainWindow) return;
        this.mainWindow.webContents.on('did-fail-load', () => {
            console.log(`Fail Load`)
            if (this.mainWindow) this.loadUrl(this.mainWindow);
        });

        this.mainWindow.on('closed', () => {
            this.mainWindow = null;
        });

        this.mainWindow.on('close', async () => {
            if (this.serverProcess.connected) this.serverProcess.send('stop');
        });
    }


    private createWindow() {
        this.serverProcess.send('start');
        const windowOptions = {
            width: 1280,
            height: 800,
            webPreferences: {
              nodeIntegration: true
            }
        };
        this.mainWindow = new BrowserWindow(windowOptions);
        this.handleMainWindowEvents();
        this.loadUrl(this.mainWindow);
        //  this.mainWindow.webContents.openDevTools();
    }

    private loadUrl(window: BrowserWindow) {
        window.loadURL(
            url.format({
              pathname: path.join(__dirname, `./fe/index.html`),
              protocol: "file:",
              slashes: true
            }),
        );
    }

    private disableSecurityWarnings() {
        process.env['ELECTRON_DISABLE_SECURITY_WARNINGS'] = 'true';
    }
}


new ElectronApp(app);
