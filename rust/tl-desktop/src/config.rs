//! Desktop configuration file. The network is named explicitly; nothing is inferred.
//!
//! ```json
//! { "network": "BTCREGTEST",
//!   "node_url": "http://127.0.0.1:18443",
//!   "rpc_cookie_file": "C:/.../regtest/.cookie"      // or "rpc_user" + "rpc_password"
//! }
//! ```
//! Location: `$TL_DESKTOP_CONFIG`, else `<app config dir>/config.json`. The vault lives in
//! `<data_dir or app data dir>/<network id>/`.
//!
//! Optional fields for the legacy-API bridge (see `LegacySettings`): `node_data_dir` (absolute),
//! `relayer_hosts` (bare hostnames; default none),
//! `orderbook_urls` (exact `ws://host:port` or `wss://host` origins, `http`/`https` spellings
//! accepted, that the UI may connect its orderbook WebSocket to; default FE-speed's
//! `ws://172.81.181.19:3001`, `[]` disables the relay),
//! `tl_listener_url` (the TradeLayer listener the FE-speed UI's `/tl/*` and `/tlraw/*` routes
//! reach: an `http`/`https` loopback origin, default `http://127.0.0.1:3000`) and
//! `tl_rpc_via_listener` (`true` makes `rpc-call` answer `tl_*` methods the way FE-speed's
//! wallet-server does; default `false`, which sends them to the node as the 2024 UI expects).
//!
//! Optional TradeLayer-Rust engine (`engine.rs`; the default is the HTTP listener above):
//! `tl_engine` (`"http"` or `"tradelayer-rust"`), `tl_engine_url` (plain-http loopback origin of
//! `tradelayer-rpcd`, default `http://127.0.0.1:7360`), `tl_engine_cmd` (absolute path of the rpcd
//! binary to start and stop with the app; absent: never started) and `tl_engine_args`.

use crate::engine::{self, EngineSettings, RawEngine};
use crate::legacy::fespeed::{normalize_listener_url, DEFAULT_LISTENER_URL};
use crate::obrelay::{normalize_origin, DEFAULT_ORDERBOOK_URLS, MAX_ORDERBOOK_URLS};
use serde::Deserialize;
use std::path::{Path, PathBuf};
use tl_wallet_core::Network;

const MAX_CONFIG_BYTES: u64 = 64 * 1024;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawConfig {
    network: String,
    node_url: String,
    #[serde(default)]
    rpc_user: Option<String>,
    #[serde(default)]
    rpc_password: Option<String>,
    #[serde(default)]
    rpc_cookie_file: Option<PathBuf>,
    #[serde(default)]
    data_dir: Option<PathBuf>,
    #[serde(default)]
    idle_lock_minutes: Option<u64>,
    /// Read by the legacy bridge (`load_legacy`); validated here too so one bad file fails early.
    #[serde(default)]
    node_data_dir: Option<PathBuf>,
    #[serde(default)]
    relayer_hosts: Option<Vec<String>>,
    #[serde(default)]
    orderbook_urls: Option<Vec<String>>,
    #[serde(default)]
    tl_listener_url: Option<String>,
    #[serde(default)]
    tl_rpc_via_listener: Option<bool>,
    #[serde(default)]
    tl_engine: Option<String>,
    #[serde(default)]
    tl_engine_url: Option<String>,
    #[serde(default)]
    tl_engine_cmd: Option<PathBuf>,
    #[serde(default)]
    tl_engine_args: Option<Vec<String>>,
}

pub struct DesktopConfig {
    pub network: Network,
    pub node_url: String,
    pub rpc_user: String,
    pub rpc_password: String,
    /// Directory holding this network's vault.
    pub vault_dir: PathBuf,
    pub idle_lock_ms: u64,
}

impl std::fmt::Debug for DesktopConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DesktopConfig")
            .field("network", &self.network)
            .field("node_url", &self.node_url)
            .field("vault_dir", &self.vault_dir)
            .field("idle_lock_ms", &self.idle_lock_ms)
            .finish_non_exhaustive()
    }
}

fn read_bounded(path: &Path) -> Result<String, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("{}: {e}", path.display()))?;
    if meta.len() > MAX_CONFIG_BYTES {
        return Err(format!("{}: file too large", path.display()));
    }
    std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))
}

/// Settings for the legacy-API bridge (`legacy.rs`), read from the same file.
///
/// * `node_data_dir`: the only directory the legacy UI may read `litecoin.conf` from or create it
///   in (default: the platform Litecoin data dir). Must be absolute.
/// * `relayer_hosts`: hostnames the UI may name as its relayer API (default empty: relayer off).
/// * `orderbook_urls`: exact origins the UI may connect its orderbook socket to, normalized
///   (`ws`/`wss`; default: the orderbook server of FE-speed's `endpoints.conf.ts`; empty: relay
///   off).
/// * `tl_listener_url`: origin of the TradeLayer listener, normalised (default
///   `http://127.0.0.1:3000`).
/// * `tl_rpc_via_listener`: `rpc-call` of `tl_*` as FE-speed's wallet-server answers it.
/// * `engine`: the `tl_engine*` fields (`engine.rs`): which listener backend serves `/tl/*` and
///   `/tlraw/*`, and the optional rpcd sidecar.
#[derive(Debug, PartialEq, Eq)]
pub struct LegacySettings {
    pub node_data_dir: Option<PathBuf>,
    pub relayer_hosts: Vec<String>,
    pub orderbook_urls: Vec<String>,
    pub tl_listener_url: String,
    pub tl_rpc_via_listener: bool,
    pub engine: EngineSettings,
}

impl Default for LegacySettings {
    fn default() -> LegacySettings {
        LegacySettings {
            node_data_dir: None,
            relayer_hosts: Vec::new(),
            orderbook_urls: DEFAULT_ORDERBOOK_URLS
                .iter()
                .map(|s| s.to_string())
                .collect(),
            tl_listener_url: DEFAULT_LISTENER_URL.to_string(),
            tl_rpc_via_listener: false,
            engine: EngineSettings::default(),
        }
    }
}

/// Lenient view of the file: the legacy bridge needs neither `node_url` nor RPC credentials, so a
/// file written for the wallet window (or none at all) never blocks it.
#[derive(Deserialize)]
struct LegacyRaw {
    #[serde(default)]
    node_data_dir: Option<PathBuf>,
    #[serde(default)]
    relayer_hosts: Option<Vec<String>>,
    #[serde(default)]
    orderbook_urls: Option<Vec<String>>,
    #[serde(default)]
    tl_listener_url: Option<String>,
    #[serde(default)]
    tl_rpc_via_listener: Option<bool>,
    #[serde(default)]
    tl_engine: Option<String>,
    #[serde(default)]
    tl_engine_url: Option<String>,
    #[serde(default)]
    tl_engine_cmd: Option<PathBuf>,
    #[serde(default)]
    tl_engine_args: Option<Vec<String>>,
}

const MAX_RELAYER_HOSTS: usize = 16;

fn valid_host(h: &str) -> bool {
    !h.is_empty()
        && h.len() <= 253
        && !h.starts_with(['.', '-'])
        && !h.ends_with(['.', '-'])
        && !h.contains("..")
        && h.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-')
}

#[cfg(test)]
fn validate_legacy(
    node_data_dir: Option<PathBuf>,
    relayer_hosts: Option<Vec<String>>,
    orderbook_urls: Option<Vec<String>>,
) -> Result<LegacySettings, String> {
    validate_legacy_full(LegacyInput {
        node_data_dir,
        relayer_hosts,
        orderbook_urls,
        ..LegacyInput::default()
    })
}

/// The legacy-bridge fields of the config file, before validation.
#[derive(Default)]
struct LegacyInput {
    node_data_dir: Option<PathBuf>,
    relayer_hosts: Option<Vec<String>>,
    orderbook_urls: Option<Vec<String>>,
    tl_listener_url: Option<String>,
    tl_rpc_via_listener: Option<bool>,
    engine: RawEngine,
}

fn validate_legacy_full(input: LegacyInput) -> Result<LegacySettings, String> {
    let LegacyInput {
        node_data_dir,
        relayer_hosts,
        orderbook_urls,
        tl_listener_url,
        tl_rpc_via_listener,
        engine,
    } = input;
    if let Some(d) = &node_data_dir {
        if !d.is_absolute() {
            return Err("config: node_data_dir must be an absolute path".into());
        }
    }
    let hosts = relayer_hosts.unwrap_or_default();
    if hosts.len() > MAX_RELAYER_HOSTS {
        return Err("config: too many relayer_hosts".into());
    }
    let hosts: Vec<String> = hosts.iter().map(|h| h.to_ascii_lowercase()).collect();
    if let Some(bad) = hosts.iter().find(|h| !valid_host(h)) {
        return Err(format!(
            "config: relayer_hosts entry {bad:?} is not a bare hostname"
        ));
    }
    let orderbook_urls = match orderbook_urls {
        None => LegacySettings::default().orderbook_urls,
        Some(urls) => {
            if urls.len() > MAX_ORDERBOOK_URLS {
                return Err("config: too many orderbook_urls".into());
            }
            let mut out: Vec<String> = Vec::new();
            for u in &urls {
                let o = normalize_origin(u)
                    .map_err(|e| format!("config: orderbook_urls entry {u:?}: {e}"))?;
                if !out.contains(&o) {
                    out.push(o);
                }
            }
            out
        }
    };
    let tl_listener_url = match tl_listener_url {
        None => DEFAULT_LISTENER_URL.to_string(),
        Some(u) => {
            normalize_listener_url(&u).map_err(|e| format!("config: tl_listener_url {u:?}: {e}"))?
        }
    };
    Ok(LegacySettings {
        node_data_dir,
        relayer_hosts: hosts,
        orderbook_urls,
        tl_listener_url,
        tl_rpc_via_listener: tl_rpc_via_listener.unwrap_or(false),
        engine: engine::validate(engine)?,
    })
}

/// Legacy-bridge settings from the config file. A missing file means the defaults.
pub fn load_legacy(path: &Path) -> Result<LegacySettings, String> {
    if !path.exists() {
        return Ok(LegacySettings::default());
    }
    let text = read_bounded(path)?;
    let raw: LegacyRaw = serde_json::from_str(&text).map_err(|e| format!("config: {e}"))?;
    validate_legacy_full(LegacyInput {
        node_data_dir: raw.node_data_dir,
        relayer_hosts: raw.relayer_hosts,
        orderbook_urls: raw.orderbook_urls,
        tl_listener_url: raw.tl_listener_url,
        tl_rpc_via_listener: raw.tl_rpc_via_listener,
        engine: RawEngine {
            engine: raw.tl_engine,
            url: raw.tl_engine_url,
            cmd: raw.tl_engine_cmd,
            args: raw.tl_engine_args,
        },
    })
}

/// Parse a config file. `default_data_dir` is used when the file names no `data_dir`.
pub fn load(path: &Path, default_data_dir: &Path) -> Result<DesktopConfig, String> {
    let text = read_bounded(path)?;
    parse(&text, default_data_dir)
}

pub fn parse(text: &str, default_data_dir: &Path) -> Result<DesktopConfig, String> {
    let raw: RawConfig = serde_json::from_str(text).map_err(|e| format!("config: {e}"))?;
    let network = Network::parse(&raw.network).map_err(|e| format!("config network: {e:?}"))?;
    let (rpc_user, rpc_password) = match (raw.rpc_cookie_file, raw.rpc_user, raw.rpc_password) {
        (Some(cookie), None, None) => {
            let text = read_bounded(&cookie)?;
            let line = text.trim_end_matches(['\r', '\n']);
            let (u, p) = line
                .split_once(':')
                .ok_or_else(|| "cookie file has no user:password".to_string())?;
            (u.to_string(), p.to_string())
        }
        (None, Some(u), Some(p)) => (u, p),
        _ => {
            return Err(
                "config: give either rpc_cookie_file or both rpc_user and rpc_password".into(),
            )
        }
    };
    validate_legacy_full(LegacyInput {
        node_data_dir: raw.node_data_dir,
        relayer_hosts: raw.relayer_hosts,
        orderbook_urls: raw.orderbook_urls,
        tl_listener_url: raw.tl_listener_url,
        tl_rpc_via_listener: raw.tl_rpc_via_listener,
        engine: RawEngine {
            engine: raw.tl_engine,
            url: raw.tl_engine_url,
            cmd: raw.tl_engine_cmd,
            args: raw.tl_engine_args,
        },
    })?;
    let idle_minutes = raw.idle_lock_minutes.unwrap_or(10);
    if !(1..=24 * 60).contains(&idle_minutes) {
        return Err("config: idle_lock_minutes must be 1..=1440".into());
    }
    let data_dir = raw
        .data_dir
        .unwrap_or_else(|| default_data_dir.to_path_buf());
    Ok(DesktopConfig {
        vault_dir: data_dir.join(network.id()),
        network,
        node_url: raw.node_url,
        rpc_user,
        rpc_password,
        idle_lock_ms: idle_minutes * 60_000,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_credentials_parse() {
        let c = parse(
            r#"{"network":"BTCREGTEST","node_url":"http://127.0.0.1:18443","rpc_user":"u","rpc_password":"p"}"#,
            Path::new("/data"),
        )
        .unwrap();
        assert_eq!(c.network, Network::BtcRegtest);
        assert_eq!(c.vault_dir, Path::new("/data").join("BTCREGTEST"));
        assert_eq!(c.idle_lock_ms, 600_000);
        assert!(!format!("{c:?}").contains("\"p\""));
    }

    #[test]
    fn legacy_fields_parse_and_are_validated() {
        let base = r#"{"network":"BTCREGTEST","node_url":"x","rpc_user":"u","rpc_password":"p""#;
        let d = Path::new("/data");
        let abs = if cfg!(windows) { "C:/ltc" } else { "/ltc" };
        assert!(parse(
            &format!(r#"{base},"node_data_dir":"{abs}","relayer_hosts":["Relayer.Example"]}}"#),
            d
        )
        .is_ok());
        assert!(parse(&format!(r#"{base},"node_data_dir":"relative"}}"#), d).is_err());
        assert!(parse(
            &format!(r#"{base},"relayer_hosts":["https://r.example"]}}"#),
            d
        )
        .is_err());

        let s = validate_legacy(
            Some(PathBuf::from(abs)),
            Some(vec!["Relayer.Example".into()]),
            None,
        )
        .unwrap();
        assert_eq!(s.relayer_hosts, vec!["relayer.example".to_string()]);
        assert_eq!(
            validate_legacy(None, None, None).unwrap(),
            LegacySettings::default()
        );
        for bad in [
            "",
            "a b",
            "r.example:443",
            "r.example/x",
            ".r",
            "r..e",
            "-r",
            "a_b",
            "r.example.",
        ] {
            assert!(
                validate_legacy(None, Some(vec![bad.into()]), None).is_err(),
                "{bad:?}"
            );
        }
        assert!(validate_legacy(None, Some(vec!["a.example".into(); 17]), None).is_err());
    }

    #[test]
    fn orderbook_urls_default_normalize_and_reject_bad_entries() {
        let defaults = validate_legacy(None, None, None).unwrap().orderbook_urls;
        assert_eq!(defaults, vec!["ws://172.81.181.19:3001".to_string()]);
        let s = validate_legacy(
            None,
            None,
            Some(vec![
                "HTTPS://Ob.Example:443/".into(),
                "wss://ob.example".into(),
                "http://127.0.0.1:18190".into(),
                "ws://127.0.0.1:3001".into(),
            ]),
        )
        .unwrap();
        // `http`/`https` are the same origins as `ws`/`wss`; duplicates collapse.
        assert_eq!(
            s.orderbook_urls,
            vec![
                "wss://ob.example".to_string(),
                "ws://127.0.0.1:18190".to_string(),
                "ws://127.0.0.1:3001".to_string()
            ]
        );
        assert!(validate_legacy(None, None, Some(vec![]))
            .unwrap()
            .orderbook_urls
            .is_empty());
        for bad in [
            "",
            "ob.example",
            "ftp://ob.example",
            "ws://ob.example/ws",
            "http://ob.example/ns",
            "http://u:p@ob.example",
            "http://ob.example/?q=1",
        ] {
            assert!(
                validate_legacy(None, None, Some(vec![bad.into()])).is_err(),
                "{bad:?}"
            );
        }
        assert!(validate_legacy(None, None, Some(vec!["http://a.example".into(); 17])).is_err());
        let d = Path::new("/data");
        let base = r#"{"network":"BTCREGTEST","node_url":"x","rpc_user":"u","rpc_password":"p""#;
        assert!(parse(
            &format!(r#"{base},"orderbook_urls":["http://ob.example:1"]}}"#),
            d
        )
        .is_ok());
        assert!(parse(
            &format!(r#"{base},"orderbook_urls":["ftp://ob.example"]}}"#),
            d
        )
        .is_err());
    }

    #[test]
    fn tl_listener_settings_default_normalize_and_reject_non_loopback_origins() {
        let d = validate_legacy(None, None, None).unwrap();
        assert_eq!(d.tl_listener_url, "http://127.0.0.1:3000");
        assert!(!d.tl_rpc_via_listener);
        let s = validate_legacy_full(LegacyInput {
            tl_listener_url: Some("HTTP://LocalHost:3001/".into()),
            tl_rpc_via_listener: Some(true),
            ..LegacyInput::default()
        })
        .unwrap();
        assert_eq!(s.tl_listener_url, "http://localhost:3001");
        assert!(s.tl_rpc_via_listener);
        for bad in [
            "",
            "http://example.com:3000",
            "ws://127.0.0.1:3000",
            "http://127.0.0.1:3000/tl",
            "http://u:p@127.0.0.1:3000",
        ] {
            assert!(
                validate_legacy_full(LegacyInput {
                    tl_listener_url: Some(bad.into()),
                    ..LegacyInput::default()
                })
                .is_err(),
                "{bad:?}"
            );
        }
        let base = r#"{"network":"BTCREGTEST","node_url":"x","rpc_user":"u","rpc_password":"p""#;
        let p = Path::new("/data");
        assert!(parse(
            &format!(
                r#"{base},"tl_listener_url":"http://127.0.0.1:4000","tl_rpc_via_listener":true}}"#
            ),
            p
        )
        .is_ok());
        assert!(parse(
            &format!(r#"{base},"tl_listener_url":"http://example.com"}}"#),
            p
        )
        .is_err());
    }

    #[test]
    fn tl_engine_fields_default_to_the_http_listener_and_validate() {
        let d = validate_legacy(None, None, None).unwrap();
        assert_eq!(d.engine, EngineSettings::default());
        let base = r#"{"network":"BTCREGTEST","node_url":"x","rpc_user":"u","rpc_password":"p""#;
        let p = Path::new("/data");
        let cmd = if cfg!(windows) {
            "C:/tl/rpcd.exe"
        } else {
            "/tl/rpcd"
        };
        assert!(parse(
            &format!(
                r#"{base},"tl_engine":"tradelayer-rust","tl_engine_url":"http://127.0.0.1:7361","tl_engine_cmd":"{cmd}","tl_engine_args":["--bind","127.0.0.1:7361"]}}"#
            ),
            p
        )
        .is_ok());
        for bad in [
            r#","tl_engine":"tradelayer-rust","tl_engine_url":"http://example.com:7360""#,
            r#","tl_engine":"nope""#,
            r#","tl_engine_url":"http://127.0.0.1:7360""#,
            r#","tl_engine":"tradelayer-rust","tl_engine_cmd":"rpcd.exe""#,
        ] {
            assert!(parse(&format!("{base}{bad}}}"), p).is_err(), "{bad}");
        }
        let dir = std::env::temp_dir().join(format!("tl-cfg-engine-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("config.json");
        std::fs::write(&f, r#"{"tl_engine":"tradelayer-rust"}"#).unwrap();
        let s = load_legacy(&f).unwrap();
        assert_eq!(s.engine.engine, engine::Engine::TradelayerRust);
        assert_eq!(s.engine.url, engine::DEFAULT_ENGINE_URL);
        assert!(s.engine.cmd.is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn legacy_settings_load_independently_of_the_wallet_fields() {
        let dir = std::env::temp_dir().join(format!("tl-cfg-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("config.json");
        assert_eq!(
            load_legacy(&dir.join("absent.json")).unwrap(),
            LegacySettings::default()
        );
        std::fs::write(
            &f,
            r#"{"relayer_hosts":["r.example"],"network":"BTCREGTEST","anything":1}"#,
        )
        .unwrap();
        assert_eq!(
            load_legacy(&f).unwrap().relayer_hosts,
            vec!["r.example".to_string()]
        );
        std::fs::write(&f, r#"{"relayer_hosts":"r.example"}"#).unwrap();
        assert!(load_legacy(&f).is_err());
        std::fs::write(&f, "not json").unwrap();
        assert!(load_legacy(&f).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ambiguous_or_unknown_settings_are_rejected() {
        let d = Path::new("/data");
        assert!(parse(
            r#"{"network":"REGTEST","node_url":"x","rpc_user":"u","rpc_password":"p"}"#,
            d
        )
        .is_err());
        assert!(parse(
            r#"{"network":"BTCREGTEST","node_url":"x","rpc_user":"u"}"#,
            d
        )
        .is_err());
        assert!(parse(r#"{"network":"BTCREGTEST","node_url":"x","rpc_user":"u","rpc_password":"p","extra":1}"#, d).is_err());
        assert!(parse(r#"{"network":"BTCREGTEST","node_url":"x","rpc_user":"u","rpc_password":"p","idle_lock_minutes":0}"#, d).is_err());
    }
}
