//! The service gate. Legacy `fastify-server.ts` / `socket.service.ts` served every route and every
//! RPC method to any local process or web page: no authentication, no Host/Origin checks, an
//! arbitrary-method RPC proxy (`main.route.ts:10`) and socket.io with `cors: { origin: "*" }`
//! (`socket.service.ts:15`). A request is admitted only if ALL of these hold:
//!
//! 1. the peer address is loopback,
//! 2. the `Host` header is exactly `localhost|127.0.0.1|[::1]` plus the service port,
//! 3. the `Origin` header, when present, is in the configured allowlist,
//! 4. a valid per-session token was presented (constant-time comparison),
//! 5. for RPC proxying, the method is in the allowlist.

use std::collections::BTreeSet;

pub const TOKEN_BYTES: usize = 32;
pub const MAX_RPC_PARAMS: usize = 16;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Deny {
    /// Peer is not a loopback address.
    NotLoopbackPeer,
    /// Host header missing or not a loopback name with the service port (DNS-rebinding defence).
    BadHost,
    /// Origin header present but not allowlisted.
    ForbiddenOrigin,
    /// No session token presented.
    MissingToken,
    /// Token presented but wrong.
    BadToken,
    /// RPC method not allowlisted (or malformed method name).
    MethodNotAllowed,
    /// RPC parameter list too long.
    TooManyParams,
}

impl Deny {
    pub fn status(self) -> u16 {
        match self {
            Deny::MissingToken | Deny::BadToken => 401,
            _ => 403,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TokenError {
    WrongLength,
    NotHex,
    Degenerate,
}

/// 32 random bytes chosen by the launcher (Electron main) per run. This crate does not generate
/// entropy (std-only); the caller injects it.
#[derive(Clone, PartialEq, Eq)]
pub struct SessionToken([u8; TOKEN_BYTES]);

impl std::fmt::Debug for SessionToken {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SessionToken(<redacted>)")
    }
}

impl SessionToken {
    pub fn from_bytes(b: &[u8]) -> Result<SessionToken, TokenError> {
        let arr: [u8; TOKEN_BYTES] = b.try_into().map_err(|_| TokenError::WrongLength)?;
        if arr.iter().all(|x| *x == arr[0]) {
            return Err(TokenError::Degenerate);
        }
        Ok(SessionToken(arr))
    }

    pub fn from_hex(s: &str) -> Result<SessionToken, TokenError> {
        if s.len() != TOKEN_BYTES * 2 {
            return Err(TokenError::WrongLength);
        }
        let mut out = [0u8; TOKEN_BYTES];
        for (i, chunk) in s.as_bytes().chunks(2).enumerate() {
            let hi = hex_val(chunk[0]).ok_or(TokenError::NotHex)?;
            let lo = hex_val(chunk[1]).ok_or(TokenError::NotHex)?;
            out[i] = (hi << 4) | lo;
        }
        SessionToken::from_bytes(&out)
    }

    pub fn to_hex(&self) -> String {
        self.0.iter().map(|b| format!("{b:02x}")).collect()
    }

    /// Constant-time check of a presented hex token.
    pub fn verify(&self, presented: &str) -> bool {
        let expected = self.to_hex();
        let (a, b) = (expected.as_bytes(), presented.as_bytes());
        let mut diff = (a.len() ^ b.len()) as u8;
        for (i, x) in a.iter().enumerate() {
            let y = b.get(i).copied().unwrap_or(0);
            diff |= x.to_ascii_lowercase() ^ y.to_ascii_lowercase();
        }
        diff == 0
    }
}

fn hex_val(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

/// Exact method names the desktop UI uses (inventory of `rpcService.rpc(...)`, `smartRpc(...)` and
/// the swapper `client(...)` calls in the pinned source) plus payload builders.
const EXACT_METHODS: &[&str] = &[
    "validateaddress",
    "decoderawtransaction",
    "addmultisigaddress",
    "sendrawtransaction",
    "listunspent",
    "createrawtransaction",
    "signrawtransaction",
    "getblockchaininfo",
    "getaddressesbylabel",
    "getnewaddress",
    "createwallet",
    "loadwallet",
    "importpubkey",
    "rescanblockchain",
    "abortrescan",
    "tl_getinfo",
    "tl_getproperty",
    "tl_getfullposition",
    "tl_getallbalancesforaddress",
    "tl_decodetransaction",
    "tl_isaddresswinner",
    "tl_check_commits",
    "tl_check_kyc",
    "tl_listnodereward_addresses",
    "tl_createrawtx_opreturn",
    "tl_createrawtx_reference",
];

/// Payload builders only construct hex; they never touch keys or the chain.
const PREFIXES: &[&str] = &["tl_createpayload_"];

#[derive(Clone, Debug)]
pub struct MethodAllowlist {
    exact: BTreeSet<String>,
    prefixes: Vec<String>,
}

impl MethodAllowlist {
    pub fn wallet_default() -> MethodAllowlist {
        MethodAllowlist::new(EXACT_METHODS, PREFIXES)
    }

    pub fn new(exact: &[&str], prefixes: &[&str]) -> MethodAllowlist {
        MethodAllowlist {
            exact: exact.iter().map(|s| s.to_string()).collect(),
            prefixes: prefixes.iter().map(|s| s.to_string()).collect(),
        }
    }

    pub fn allows(&self, method: &str) -> bool {
        let well_formed = !method.is_empty()
            && method.len() <= 64
            && method
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_');
        if !well_formed {
            return false;
        }
        self.exact.contains(method) || self.prefixes.iter().any(|p| method.starts_with(p.as_str()))
    }
}

#[derive(Clone, Debug)]
pub struct GateConfig {
    pub port: u16,
    pub token: SessionToken,
    /// Exact Origin header values (e.g. `file://` for the packaged Electron renderer or
    /// `http://localhost:4200` for the dev server). Empty means browsers are never admitted.
    pub allowed_origins: Vec<String>,
    pub methods: MethodAllowlist,
}

/// The transport-level facts about one request or socket handshake.
#[derive(Clone, Debug, Default)]
pub struct RequestMeta<'a> {
    pub peer_is_loopback: bool,
    pub host: Option<&'a str>,
    pub origin: Option<&'a str>,
    pub token: Option<&'a str>,
}

#[derive(Clone, Debug)]
pub struct Gate {
    cfg: GateConfig,
}

impl Gate {
    pub fn new(cfg: GateConfig) -> Gate {
        Gate { cfg }
    }

    pub fn config(&self) -> &GateConfig {
        &self.cfg
    }

    fn host_ok(&self, host: &str) -> bool {
        let port = self.cfg.port;
        let h = host.to_ascii_lowercase();
        h == format!("localhost:{port}")
            || h == format!("127.0.0.1:{port}")
            || h == format!("[::1]:{port}")
    }

    /// Admission for any HTTP route or socket handshake.
    pub fn check(&self, m: &RequestMeta<'_>) -> Result<(), Deny> {
        if !m.peer_is_loopback {
            return Err(Deny::NotLoopbackPeer);
        }
        match m.host {
            Some(h) if self.host_ok(h) => {}
            _ => return Err(Deny::BadHost),
        }
        if let Some(o) = m.origin {
            if !self.cfg.allowed_origins.iter().any(|a| a == o) {
                return Err(Deny::ForbiddenOrigin);
            }
        }
        match m.token {
            None => Err(Deny::MissingToken),
            Some(t) if self.cfg.token.verify(t) => Ok(()),
            Some(_) => Err(Deny::BadToken),
        }
    }

    /// Additional check for the RPC proxy route.
    pub fn check_rpc(&self, method: &str, param_count: usize) -> Result<(), Deny> {
        if !self.cfg.methods.allows(method) {
            return Err(Deny::MethodNotAllowed);
        }
        if param_count > MAX_RPC_PARAMS {
            return Err(Deny::TooManyParams);
        }
        Ok(())
    }

    /// CORS response header value: only an allowlisted Origin is ever echoed (never `*`).
    pub fn cors_allow_origin(&self, origin: Option<&str>) -> Option<String> {
        let o = origin?;
        if self.cfg.allowed_origins.iter().any(|a| a == o) {
            Some(o.to_string())
        } else {
            None
        }
    }
}

impl Gate {
    /// CORS preflight (`OPTIONS`) cannot carry the session header; it is answered from the
    /// peer/Host/Origin checks alone and only an allowlisted Origin gets CORS headers back.
    pub fn check_preflight(&self, m: &RequestMeta<'_>) -> Result<(), Deny> {
        if !m.peer_is_loopback {
            return Err(Deny::NotLoopbackPeer);
        }
        match m.host {
            Some(h) if self.host_ok(h) => {}
            _ => return Err(Deny::BadHost),
        }
        match m.origin {
            Some(o) if self.cfg.allowed_origins.iter().any(|a| a == o) => Ok(()),
            _ => Err(Deny::ForbiddenOrigin),
        }
    }
}
