"use strict";
// Loaded before the Angular bundles of the FE-speed build (scripts/build-ui.mjs --ref ... --name
// fe-speed injects it into index.html). FE-speed's ElectronService reads window.tradelayerElectron,
// the contextBridge object exposed by its Electron preload (builder/preload.ts):
//   emitEvent(event, data?)    throws for events outside the preload's outbound list
//   getLocalApiToken()         the --tl-local-api-token Electron passes to the renderer ('' when unset)
//   onMessage(listener)        listener({ event, data }) for every main-process message; returns unsubscribe
//   onceMessage(listener)      same, for the first message only
// The main process answered three outbound events (builder/electron-builder.ts, auto-updater.ts):
//   'check-version'        -> auto-updater replies { event: 'update-app', data: { state } }
//   'download-new-version' -> auto-updater download
//   'open-dir-dialog'      -> native folder picker, replies { event: 'selected-dir', data: <path or ''> }
// The desktop build has no auto-updater and no folder picker. 'check-version' is answered with
// state 3 (the updater's "update-not-available", which closes the update dialog), 'open-dir-dialog'
// with an empty selection (the sync-node dialog keeps its text field), 'download-new-version' is
// dropped. The Rust backend authenticates through the tlapi scheme, so there is no local API token.
(function () {
  const CHANNEL_EVENTS = Object.freeze(["open-dir-dialog", "check-version", "download-new-version"]);
  const listeners = [];
  const deliver = (event, data) => {
    setTimeout(() => {
      for (const entry of listeners.slice()) {
        if (entry.once) remove(entry);
        try { entry.fn({ event, data }); } catch (e) { console.error(e); }
      }
    }, 0);
  };
  const remove = (entry) => {
    const i = listeners.indexOf(entry);
    if (i >= 0) listeners.splice(i, 1);
  };
  const subscribe = (fn, once) => {
    if (typeof fn !== "function") throw new TypeError("listener must be a function");
    const entry = { fn, once };
    listeners.push(entry);
    return () => remove(entry);
  };
  const bridge = Object.freeze({
    emitEvent(event, data) {
      if (!CHANNEL_EVENTS.includes(event)) throw new Error("Blocked IPC event: " + event);
      if (event === "check-version") deliver("update-app", { state: 3, data: null });
      else if (event === "open-dir-dialog") deliver("selected-dir", "");
      else console.info("tl-desktop: Electron event not available in the desktop build:", event);
    },
    getLocalApiToken() {
      return "";
    },
    onMessage(listener) {
      return subscribe(listener, false);
    },
    onceMessage(listener) {
      return subscribe(listener, true);
    },
  });
  Object.defineProperty(window, "tradelayerElectron", {
    value: bridge,
    writable: false,
    configurable: false,
  });
})();
