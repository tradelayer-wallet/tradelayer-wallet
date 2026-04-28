export {};

declare global {
    interface Window {
        tradelayerElectron?: {
            emitEvent: (event: string, data?: unknown) => void;
            getLocalApiToken: () => string;
            onMessage: (listener: (message: { event: string; data?: unknown }) => void) => (() => void);
            onceMessage: (listener: (message: { event: string; data?: unknown }) => void) => (() => void);
        };
    }
}
