import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

type ElectronMessage = {
    event: string;
    data?: unknown;
};

const outboundEvents = new Set([
    'open-dir-dialog',
    'check-version',
    'download-new-version',
]);

const localApiTokenArg = process.argv.find((arg) => arg.startsWith('--tl-local-api-token='));
const localApiToken = localApiTokenArg
    ? localApiTokenArg.slice('--tl-local-api-token='.length)
    : '';

const sanitizeMessage = (message: any): ElectronMessage => ({
    event: typeof message?.event === 'string' ? message.event : '',
    data: message?.data,
});

const subscribe = (listener: (message: ElectronMessage) => void, once = false) => {
    const wrappedListener = (_event: IpcRendererEvent, message: unknown) => {
        listener(sanitizeMessage(message));
    };

    if (once) {
        ipcRenderer.once('angular-electron-message', wrappedListener);
        return () => ipcRenderer.removeListener('angular-electron-message', wrappedListener);
    }

    ipcRenderer.on('angular-electron-message', wrappedListener);
    return () => ipcRenderer.removeListener('angular-electron-message', wrappedListener);
};

contextBridge.exposeInMainWorld('tradelayerElectron', {
    emitEvent(event: string, data?: unknown) {
        if (!outboundEvents.has(event)) {
            throw new Error(`Blocked IPC event: ${event}`);
        }
        ipcRenderer.send('angular-electron-message', { event, data });
    },
    getLocalApiToken() {
        return localApiToken;
    },
    onMessage(listener: (message: ElectronMessage) => void) {
        return subscribe(listener, false);
    },
    onceMessage(listener: (message: ElectronMessage) => void) {
        return subscribe(listener, true);
    },
});
