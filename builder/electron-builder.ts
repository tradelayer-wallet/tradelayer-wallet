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
            stdio: 'pipe'
        });
        this.serverProcess.send('init');
    }

    private handleOnEvents() {
        this.app.on('ready', () => this.createWindow());

        this.app.on('window-all-closed', () => {
            this.serverProcess.send('stop');
            if (process.platform !== 'darwin') app.quit();
        });

        this.app.on('activate', () => {
            console.log('activate')
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
            this.mainWindow = null
          })
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
         this.mainWindow.webContents.openDevTools();
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
