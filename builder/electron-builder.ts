import { App, app, BrowserWindow, globalShortcut } from 'electron';
import * as url from 'url';
import * as path from 'path';
import * as reloader from 'electron-reloader';

class ElectronApp {
    private app: App;
    private mainWindow: BrowserWindow | null = null;
    constructor(app: App) {
        this.app = app;
        this.handleOnEvents();
        this.runReloader();
        this.disableSecurityWarnings();
    }

    private handleOnEvents() {
        this.app.on('ready', () => this.createWindow());

        this.app.on('window-all-closed', () => {
            if (process.platform !== 'darwin') app.quit()
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

    private runReloader() {
        try {
            reloader(module);
        } catch (error) {
            return;
        }
    }

    private disableSecurityWarnings() {
        process.env['ELECTRON_DISABLE_SECURITY_WARNINGS'] = 'true';
    }
}


new ElectronApp(app);
