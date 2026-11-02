"use strict";
// Loaded before the Angular bundles (scripts/build-ui.mjs injects it into index.html).
// wallet-fe's ElectronService calls window.require('electron') at module load and talks to the
// Electron main process over ipcRenderer('angular-electron-message'). The main process handled
// three events (builder/electron-builder.ts, builder/auto-updater.ts):
//   'check-version'        -> auto-updater replies { event: 'update-app', data: { state } }
//   'download-new-version' -> auto-updater download
//   'open-dir-dialog'      -> native folder picker, replies 'selected-dir'
// The desktop build has no auto-updater (releases are verified and installed separately), so
// 'check-version' is answered with state 3, the updater's "update-not-available", which is the
// state that closes the update dialog. The other two are dropped; the sync-node dialog keeps its
// text field for the data directory.
(function () {
  const CHANNEL = "angular-electron-message";
  const listeners = [];
  const deliver = (event, data) => {
    setTimeout(() => {
      for (const cb of listeners.slice()) {
        try { cb({}, { event, data }); } catch (e) { console.error(e); }
      }
    }, 0);
  };
  const ipcRenderer = Object.freeze({
    send(channel, message) {
      if (channel !== CHANNEL) return;
      const event = message && typeof message.event === "string" ? message.event : "";
      if (event === "check-version") {
        deliver("update-app", { state: 3, data: null });
        return;
      }
      console.info("tl-desktop: Electron event not available in the desktop build:", event);
    },
    on(channel, callback) {
      if (channel === CHANNEL && typeof callback === "function") listeners.push(callback);
      return ipcRenderer;
    },
  });
  const electron = Object.freeze({ ipcRenderer });
  Object.defineProperty(window, "require", {
    value: function (name) {
      if (name === "electron") return electron;
      throw new Error("require is not available: " + String(name));
    },
    writable: false,
    configurable: false,
  });
})();
