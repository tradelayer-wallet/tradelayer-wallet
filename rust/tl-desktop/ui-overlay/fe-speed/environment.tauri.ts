import { ENDPOINTS } from "./endpoints.conf";

// Desktop build inside the Rust/Tauri shell (rust/tl-desktop): the wallet API is served by Rust
// over the `tlapi` custom protocol instead of the Node wallet-server on localhost:1986. ENDPOINTS
// (orderbook and relayer URLs) are FE-speed's own, unchanged.
export const environment = {
    production: true,
    homeApiUrl: "http://tlapi.localhost",
    ENDPOINTS,
};
