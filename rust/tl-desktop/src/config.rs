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
