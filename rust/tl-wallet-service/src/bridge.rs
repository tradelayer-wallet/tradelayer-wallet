//! Policy for the wallet <-> orderbook socket bridge (`wallet-server/src/services/socket.service.ts`
//! and `ob-sockets.service.ts`). The I/O (socket.io server and client) stays an adapter; this
//! module decides what may pass.
//!
//! Repaired defects:
//! * `new Server(app.server, { cors: { origin: "*" } })` and `onConnection` accepted any browser
//!   origin and let the newest connection replace the wallet socket: the handshake now goes through
//!   `Gate::check` (loopback, Host, Origin, session token).
//! * the orderbook URL came straight from the socket event: it is validated (`nodecfg`).
//! * wallet -> orderbook forwarding is limited to four event names, orderbook -> wallet to six, and
//!   `<id>::swap` frames only for the orderbook socket's own id (outbound) or a counterparty
//!   registered from a `new-channel` event (inbound), with a payload size bound.

use crate::gate::{Deny, Gate, RequestMeta};
use crate::nodecfg::{validate_endpoint, CfgError, Endpoint};
use crate::swap::types::SessionId;
use std::collections::BTreeSet;

pub const EVENT_PREFIX: &str = "OB_SOCKET";
pub const WALLET_TO_OB: [&str; 4] = [
    "update-orderbook",
    "new-order",
    "close-order",
    "many-orders",
];
pub const OB_TO_WALLET: [&str; 6] = [
    "order:error",
    "order:saved",
    "placed-orders",
    "orderbook-data",
    "update-orders-request",
    "new-channel",
];
pub const MAX_EVENT_BYTES: usize = 64 * 1024;
pub const MAX_PEERS: usize = 32;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Decision {
    /// Forward under this event name.
    Forward(String),
    Drop(&'static str),
}

#[derive(Debug)]
pub struct Bridge {
    gate: Gate,
    allowed_ob_hosts: Vec<String>,
    wallet_conn: Option<u64>,
    ob: Option<Endpoint>,
    ob_socket_id: Option<SessionId>,
    peers: BTreeSet<SessionId>,
}

impl Bridge {
    pub fn new(gate: Gate, allowed_ob_hosts: Vec<String>) -> Bridge {
        Bridge {
            gate,
            allowed_ob_hosts,
            wallet_conn: None,
            ob: None,
            ob_socket_id: None,
            peers: BTreeSet::new(),
        }
    }

    /// Socket.io handshake of the wallet UI. Replacing an existing connection requires a valid
    /// handshake too, so an unauthenticated page cannot take over the bridge.
    pub fn wallet_connect(&mut self, conn: u64, meta: &RequestMeta<'_>) -> Result<(), Deny> {
        self.gate.check(meta)?;
        self.wallet_conn = Some(conn);
        Ok(())
    }

    pub fn wallet_disconnect(&mut self, conn: u64) {
        if self.wallet_conn == Some(conn) {
            self.wallet_conn = None;
        }
    }

    /// `ob-sockets-connect`: validate the URL; the adapter then dials it.
    pub fn connect_ob(&mut self, conn: u64, url: &str) -> Result<Endpoint, CfgError> {
        if self.wallet_conn != Some(conn) {
            return Err(CfgError::BadUrl);
        }
        let ep = validate_endpoint(url, &self.allowed_ob_hosts)?;
        self.ob = Some(ep.clone());
        Ok(ep)
    }

    pub fn disconnect_ob(&mut self) {
        self.ob = None;
        self.ob_socket_id = None;
        self.peers.clear();
    }

    pub fn set_ob_socket_id(&mut self, id: SessionId) {
        self.ob_socket_id = Some(id);
    }

    /// A `new-channel` event names the counterparty whose `<id>::swap` frames may now reach the UI.
    pub fn register_peer(&mut self, peer: SessionId) -> bool {
        if self.peers.len() >= MAX_PEERS && !self.peers.contains(&peer) {
            return false;
        }
        self.peers.insert(peer);
        true
    }

    pub fn unregister_peer(&mut self, peer: &SessionId) {
        self.peers.remove(peer);
    }

    /// Wallet UI -> orderbook.
    pub fn from_wallet(&self, conn: u64, event: &str, payload_len: usize) -> Decision {
        if self.wallet_conn != Some(conn) {
            return Decision::Drop("not the authenticated wallet connection");
        }
        if self.ob.is_none() {
            return Decision::Drop("orderbook not connected");
        }
        if payload_len > MAX_EVENT_BYTES {
            return Decision::Drop("payload too large");
        }
        if WALLET_TO_OB.contains(&event) {
            return Decision::Forward(event.to_string());
        }
        if let (Some(own), Some(sid)) = (&self.ob_socket_id, event.strip_suffix("::swap")) {
            if sid == own.as_str() {
                return Decision::Forward(event.to_string());
            }
        }
        Decision::Drop("event not allowed")
    }

    /// Orderbook -> wallet UI. Names get the `OB_SOCKET::` prefix.
    pub fn from_orderbook(&self, event: &str, payload_len: usize) -> Decision {
        if payload_len > MAX_EVENT_BYTES {
            return Decision::Drop("payload too large");
        }
        if OB_TO_WALLET.contains(&event) {
            return Decision::Forward(format!("{EVENT_PREFIX}::{event}"));
        }
        if let Some(sid) = event.strip_suffix("::swap") {
            if let Some(id) = SessionId::parse(sid) {
                if self.peers.contains(&id) {
                    return Decision::Forward(event.to_string());
                }
            }
        }
        Decision::Drop("event not allowed")
    }
}
