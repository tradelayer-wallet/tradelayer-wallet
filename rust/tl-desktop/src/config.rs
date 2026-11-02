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
//! `relayer_hosts` (bare hostnames; default none).

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
#[derive(Debug, Default, PartialEq, Eq)]
pub struct LegacySettings {
    pub node_data_dir: Option<PathBuf>,
    pub relayer_hosts: Vec<String>,
}

/// Lenient view of the file: the legacy bridge needs neither `node_url` nor RPC credentials, so a
/// file written for the wallet window (or none at all) never blocks it.
#[derive(Deserialize)]
struct LegacyRaw {
    #[serde(default)]
    node_data_dir: Option<PathBuf>,
    #[serde(default)]
    relayer_hosts: Option<Vec<String>>,
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

fn validate_legacy(
    node_data_dir: Option<PathBuf>,
    relayer_hosts: Option<Vec<String>>,
) -> Result<LegacySettings, String> {
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
    Ok(LegacySettings {
        node_data_dir,
        relayer_hosts: hosts,
    })
}

/// Legacy-bridge settings from the config file. A missing file means the defaults.
pub fn load_legacy(path: &Path) -> Result<LegacySettings, String> {
    if !path.exists() {
        return Ok(LegacySettings::default());
    }
    let text = read_bounded(path)?;
    let raw: LegacyRaw = serde_json::from_str(&text).map_err(|e| format!("config: {e}"))?;
    validate_legacy(raw.node_data_dir, raw.relayer_hosts)
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
    validate_legacy(raw.node_data_dir, raw.relayer_hosts)?;
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
        )
        .unwrap();
        assert_eq!(s.relayer_hosts, vec!["relayer.example".to_string()]);
        assert_eq!(
            validate_legacy(None, None).unwrap(),
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
                validate_legacy(None, Some(vec![bad.into()])).is_err(),
                "{bad:?}"
            );
        }
        assert!(validate_legacy(None, Some(vec!["a.example".into(); 17])).is_err());
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
