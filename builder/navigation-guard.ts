import { pathToFileURL, URL } from 'url';

// Decides where the wallet window may navigate. The renderer runs with Node integration
// (electron-builder.ts), so a document loaded into the window would get Node access. The
// window may show files from the packaged app directory only. Every other URL is refused,
// and no new window is opened. Pure: no Electron import, so it is tested without Electron.
export const isAllowedAppNavigation = (rawUrl: string, appIndexFile: string): boolean => {
    let target: URL;
    let appDir: URL;
    try {
        target = new URL(rawUrl);
        // `new URL('.', base)` is the directory of the index file, with its trailing slash.
        appDir = new URL('.', pathToFileURL(appIndexFile));
    } catch (e) {
        return false;
    }
    if (target.protocol !== 'file:' || target.host !== '') return false;
    return target.pathname.startsWith(appDir.pathname);
};
