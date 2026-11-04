import { ENDPOINTS } from "./endpoints.conf";

// Desktop build inside the Rust/Tauri shell (rust/tl-desktop): the wallet API is served by Rust
// over the `tlapi` custom protocol instead of the Node wallet-server on localhost:1986.
export const environment = {
    production: true,
    homeApiUrl: "http://tlapi.localhost",
    // TradeLayer node HTTP API (localhost:3000 in the Electron build), served by Rust as rpc-calls.
    tlApiUrl: "http://tlapi.localhost/tl",
    ENDPOINTS,
};
