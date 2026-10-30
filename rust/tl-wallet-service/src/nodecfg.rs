//! Node configuration and launch arguments (`wallet-server/src/services/node.service.ts`) and the
//! URL policy for the relayer and orderbook endpoints.
//!
//! Repaired defects:
//! * `createConfigFile` interpolated `username`/`password` into `litecoin.conf` unvalidated
//!   (`node.service.ts:58`): a value containing a newline injects further node options such as
//!   `blocknotify=<command>`. Values are now restricted to printable ASCII without whitespace,
//!   `#` or control characters.
//! * `structureConfFile` used `split('=')[1]`, truncating any value that contains `=` (`:119`).
//! * The node command line was built as one shell string with the data directory in quotes
//!   (`:110-111`, `:156`); a quote in the path escaped it. Launch arguments are now an argv vector and the
//!   path is validated.
//! * `set-api-url` / `ob-sockets-connect` accepted any URL (`main.route.ts:114`,
//!   `socket.service.ts:28`), so a page could point the wallet's address lookups or order traffic
//!   at an attacker. `validate_endpoint` requires https (or http to loopback) and an allowlisted host.

use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CfgError {
    BadUsername,
    BadPassword,
    BadPort,
    BadPath,
    BadNetwork,
    BadUrl,
    HostNotAllowed,
    Missing(&'static str),
}

impl std::fmt::Display for CfgError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}

impl std::error::Error for CfgError {}

fn safe_token(s: &str) -> bool {
    !s.is_empty() && s.len() <= 128 && s.bytes().all(|b| b.is_ascii_graphic() && b != b'#')
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NewConfig {
    pub username: String,
    pub password: String,
    pub port: u16,
    pub path: Option<String>,
}

pub fn validate_path(p: &str) -> Result<(), CfgError> {
    let ok = !p.is_empty()
        && p.len() <= 1024
        && !p.chars().any(|c| c.is_control() || c == '"' || c == '\'')
        && !p.split(['/', '\\']).any(|seg| seg == "..");
    if ok {
        Ok(())
    } else {
        Err(CfgError::BadPath)
    }
}

pub fn validate_new_config(
    username: &str,
    password: &str,
    port: i64,
    path: Option<&str>,
) -> Result<NewConfig, CfgError> {
    if !safe_token(username) || username.contains('=') {
        return Err(CfgError::BadUsername);
    }
    if !safe_token(password) {
        return Err(CfgError::BadPassword);
    }
    let port = u16::try_from(port)
        .ok()
        .filter(|p| *p >= 1)
        .ok_or(CfgError::BadPort)?;
    if let Some(p) = path {
        validate_path(p)?;
    }
    Ok(NewConfig {
        username: username.to_string(),
        password: password.to_string(),
        port,
        path: path.map(|s| s.to_string()),
    })
}

/// Exactly the legacy file layout (`node.service.ts:58`).
pub fn render_conf(c: &NewConfig) -> String {
    format!(
        "rpcuser={}\nrpcpassword={}\nrpcport={}\ntxindex=1",
        c.username, c.password, c.port
    )
}

/// `structureConfFile`, but values keep any `=`; comment lines and lines without key or value are
/// skipped; `\r` is stripped.
pub fn parse_conf(text: &str) -> BTreeMap<String, String> {
    let mut m = BTreeMap::new();
    for line in text.split('\n') {
        let line = line.trim_end_matches('\r');
        if line.starts_with('#') {
            continue;
        }
        if let Some((k, v)) = line.split_once('=') {
            if !k.is_empty() && !v.is_empty() {
                m.insert(k.to_string(), v.to_string());
            }
        }
    }
    m
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RpcEndpoint {
    pub user: String,
    pub password: String,
    pub host: String,
    pub port: u16,
}

/// Default RPC ports exactly as in the legacy code (`rpcport ? rpcport : isTestnet ? 18332 : 8332`).
/// These are Bitcoin's ports, not Litecoin's (9332/19332): left unchanged, see README.
pub const LEGACY_DEFAULT_PORT: u16 = 8332;
pub const LEGACY_DEFAULT_TESTNET_PORT: u16 = 18332;

/// Connection settings from a `litecoin.conf`. `rpchost` is only accepted when it is loopback.
pub fn rpc_endpoint(
    conf: &BTreeMap<String, String>,
    testnet: bool,
) -> Result<RpcEndpoint, CfgError> {
    let user = conf.get("rpcuser").ok_or(CfgError::Missing("rpcuser"))?;
    let password = conf
        .get("rpcpassword")
        .ok_or(CfgError::Missing("rpcpassword"))?;
    let port = match conf.get("rpcport") {
        Some(p) => p.parse::<u16>().map_err(|_| CfgError::BadPort)?,
        None if testnet => LEGACY_DEFAULT_TESTNET_PORT,
        None => LEGACY_DEFAULT_PORT,
    };
    let host = conf
        .get("rpchost")
        .cloned()
        .unwrap_or_else(|| "localhost".to_string());
    if !matches!(host.as_str(), "localhost" | "127.0.0.1" | "::1") {
        return Err(CfgError::HostNotAllowed);
    }
    Ok(RpcEndpoint {
        user: user.clone(),
        password: password.clone(),
        host,
        port,
    })
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LaunchOptions {
    pub testnet: bool,
    pub startclean: bool,
    pub reindex: bool,
    pub datadir: Option<String>,
}

/// Port of `FlagsObject` + `convertFlagsObjectToString` as an argv vector (no shell).
/// Legacy order: `-txindex=1 -printtoconsole=0`, then `testnet`, `txindex`, `startclean`,
/// `reindex`, `datadir` for the truthy ones.
pub fn launch_args(o: &LaunchOptions) -> Result<Vec<String>, CfgError> {
    let mut args = vec!["-txindex=1".to_string(), "-printtoconsole=0".to_string()];
    if o.testnet {
        args.push("-testnet=1".into());
    }
    if o.startclean {
        args.push("-startclean=1".into());
    }
    if o.reindex {
        args.push("-reindex=1".into());
    }
    if let Some(d) = &o.datadir {
        validate_path(d)?;
        args.push(format!("-datadir={d}"));
    }
    Ok(args)
}

/// `network.endsWith('TEST')` with the network restricted to the two the wallet supports.
pub fn is_testnet(network: &str) -> Result<bool, CfgError> {
    match network {
        "LTC" => Ok(false),
        "LTCTEST" => Ok(true),
        _ => Err(CfgError::BadNetwork),
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Endpoint {
    pub url: String,
    pub host: String,
}

/// `https://host[:port][/path]` where host is allowlisted, or `http://` to a loopback host.
/// No userinfo, no query/fragment, no control characters.
pub fn validate_endpoint(url: &str, allowed_hosts: &[String]) -> Result<Endpoint, CfgError> {
    if url.len() > 512 || url.bytes().any(|b| !b.is_ascii_graphic()) {
        return Err(CfgError::BadUrl);
    }
    let (scheme, rest) = url.split_once("://").ok_or(CfgError::BadUrl)?;
    if rest.contains(['?', '#', '@', '\\']) {
        return Err(CfgError::BadUrl);
    }
    let authority = rest.split('/').next().unwrap_or("");
    let host = if let Some(stripped) = authority.strip_prefix('[') {
        let (h, _) = stripped.split_once(']').ok_or(CfgError::BadUrl)?;
        h
    } else {
        authority.split(':').next().unwrap_or("")
    };
    if host.is_empty() {
        return Err(CfgError::BadUrl);
    }
    let loopback = matches!(host, "localhost" | "127.0.0.1" | "::1");
    match scheme {
        "https" => {}
        "http" if loopback => {}
        _ => return Err(CfgError::BadUrl),
    }
    let host_lc = host.to_ascii_lowercase();
    if !loopback
        && !allowed_hosts
            .iter()
            .any(|h| h.eq_ignore_ascii_case(&host_lc))
    {
        return Err(CfgError::HostNotAllowed);
    }
    Ok(Endpoint {
        url: url.trim_end_matches('/').to_string(),
        host: host_lc,
    })
}
