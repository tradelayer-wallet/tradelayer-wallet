//! TradeLayer desktop wallet: a Tauri 2 window over `tl-desktop-core`.
//!
//! There is no local HTTP server and no Node process. The bundled UI calls the commands below
//! over Tauri IPC; the wallet lives on one dedicated thread (the node client blocks on its own
//! runtime) and every command is a message to that thread. Keys never leave Rust.
//!
//! The `tlapi` custom URI scheme (`legacy.rs`) serves the original Angular UI's legacy HTTP API
//! from a second dedicated thread, again without a socket. Its `/socket.io/` path (the legacy UI's
//! main connection) is served by `socketio.rs` on a third; the orderbook relay (`obrelay.rs`) runs
//! its socket.io client threads for that module.
#![forbid(unsafe_code)]
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;
mod legacy;
mod node;
mod obrelay;
mod socketio;

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;
use tl_desktop_core::{Clock, Config, CoreError, Entropy, FileStore, Wallet};

struct SystemClock;
impl Clock for SystemClock {
    fn now_ms(&self) -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
            .unwrap_or(0)
    }
}

struct OsEntropy;
impl Entropy for OsEntropy {
    fn fill(&mut self, buf: &mut [u8]) -> Result<(), CoreError> {
        getrandom::fill(buf).map_err(|_| CoreError::Entropy)
    }
}

type DesktopWallet = Wallet<node::RpcNode, FileStore, SystemClock, OsEntropy>;
type Job = Box<dyn FnOnce(&mut Actor) + Send>;

/// State owned by the wallet thread.
struct Actor {
    wallet: Result<DesktopWallet, String>,
    idle_lock_ms: u64,
    last_use_ms: u64,
}

/// What Tauri holds: a channel to the wallet thread.
struct WalletHandle(mpsc::Sender<Job>);

impl WalletHandle {
    /// Run `f` on the wallet thread. A session idle longer than the configured time is locked
    /// before `f` runs.
    async fn run<T: Send + 'static>(
        &self,
        f: impl FnOnce(&mut DesktopWallet) -> Result<T, String> + Send + 'static,
    ) -> Result<T, String> {
        let (tx, rx) = mpsc::channel();
        let job: Job = Box::new(move |actor: &mut Actor| {
            let now = SystemClock.now_ms();
            let out = match actor.wallet.as_mut() {
                Ok(w) => {
                    if now.saturating_sub(actor.last_use_ms) > actor.idle_lock_ms {
                        w.lock();
                    }
                    actor.last_use_ms = now;
                    f(w)
                }
                Err(e) => Err(e.clone()),
            };
            let _ = tx.send(out);
        });
        let stopped = || "wallet thread stopped".to_string();
        self.0.send(job).map_err(|_| stopped())?;
        tauri::async_runtime::spawn_blocking(move || rx.recv())
            .await
            .map_err(|_| stopped())?
            .map_err(|_| stopped())?
    }
}

fn start_wallet_thread(
    config_path: PathBuf,
    default_data_dir: PathBuf,
) -> std::io::Result<WalletHandle> {
    let (tx, rx) = mpsc::channel::<Job>();
    std::thread::Builder::new()
        .name("wallet".into())
        .spawn(move || {
            let mut actor = build_actor(&config_path, &default_data_dir);
            for job in rx {
                job(&mut actor);
            }
        })?;
    Ok(WalletHandle(tx))
}

fn build_actor(config_path: &Path, default_data_dir: &Path) -> Actor {
    let built = (|| {
        let cfg = config::load(config_path, default_data_dir)?;
        let node = node::RpcNode::connect(&cfg.node_url, &cfg.rpc_user, &cfg.rpc_password)
            .map_err(|e| e.to_string())?;
        let store = FileStore::open(&cfg.vault_dir).map_err(|e| format!("vault dir: {e:?}"))?;
        let wallet = Wallet::new(
            Config::new(cfg.network),
            node,
            store,
            SystemClock,
            OsEntropy,
        );
        Ok::<_, String>((wallet, cfg.idle_lock_ms))
    })();
    match built {
        Ok((wallet, idle_lock_ms)) => Actor {
            wallet: Ok(wallet),
            idle_lock_ms,
            last_use_ms: SystemClock.now_ms(),
        },
        Err(e) => Actor {
            wallet: Err(format!("{e} (config file: {})", config_path.display())),
            idle_lock_ms: u64::MAX,
            last_use_ms: 0,
        },
    }
}

fn err(e: CoreError) -> String {
    e.to_string()
}

// ------------------------------------------------------------------ IPC types

#[derive(Serialize)]
struct StatusDto {
    network_id: String,
    has_vault: bool,
    unlocked: bool,
    node_chain: Option<String>,
    chain_matches: bool,
}

#[derive(Serialize)]
struct BalanceDto {
    confirmed_sats: u64,
    unconfirmed_sats: u64,
    immature_sats: u64,
    utxo_count: usize,
    height: u64,
}

#[derive(Serialize)]
struct PreviewDto {
    plan_id: String,
    to: String,
    amount_sats: u64,
    fee_sats: u64,
    change_sats: u64,
    input_count: usize,
    fee_rate_sat_vb: u64,
    expires_at_ms: u64,
}

#[derive(Serialize)]
struct SentDto {
    txid: String,
}

// ------------------------------------------------------------------ commands

#[tauri::command]
async fn status(h: tauri::State<'_, WalletHandle>) -> Result<StatusDto, String> {
    h.run(|w| {
        let s = w.status();
        Ok(StatusDto {
            network_id: s.network_id,
            has_vault: s.has_vault,
            unlocked: s.unlocked,
            node_chain: s.node_chain,
            chain_matches: s.chain_matches,
        })
    })
    .await
}

#[tauri::command]
async fn create_wallet(
    h: tauri::State<'_, WalletHandle>,
    password: String,
) -> Result<String, String> {
    h.run(move |w| w.create(&password).map_err(err)).await
}

#[tauri::command]
async fn import_wallet(
    h: tauri::State<'_, WalletHandle>,
    phrase: String,
    password: String,
) -> Result<(), String> {
    h.run(move |w| w.import(&phrase, &password).map_err(err))
        .await
}

#[tauri::command]
async fn unlock(h: tauri::State<'_, WalletHandle>, password: String) -> Result<(), String> {
    h.run(move |w| w.unlock(&password).map_err(err)).await
}

#[tauri::command]
async fn lock(h: tauri::State<'_, WalletHandle>) -> Result<(), String> {
    h.run(|w| {
        w.lock();
        Ok(())
    })
    .await
}

#[tauri::command]
async fn receive_address(h: tauri::State<'_, WalletHandle>) -> Result<String, String> {
    h.run(|w| w.receive_address().map_err(err)).await
}

#[tauri::command]
async fn balance(h: tauri::State<'_, WalletHandle>) -> Result<BalanceDto, String> {
    h.run(|w| {
        let b = w.balance().map_err(err)?;
        Ok(BalanceDto {
            confirmed_sats: b.confirmed_sats,
            unconfirmed_sats: b.unconfirmed_sats,
            immature_sats: b.immature_sats,
            utxo_count: b.utxo_count,
            height: b.height,
        })
    })
    .await
}

#[tauri::command]
async fn prepare_send(
    h: tauri::State<'_, WalletHandle>,
    to: String,
    amount_sats: u64,
    fee_rate: Option<u64>,
) -> Result<PreviewDto, String> {
    h.run(move |w| {
        let p = w.prepare_send(&to, amount_sats, fee_rate).map_err(err)?;
        Ok(PreviewDto {
            plan_id: p.plan_id,
            to: p.to,
            amount_sats: p.amount_sats,
            fee_sats: p.fee_sats,
            change_sats: p.change_sats,
            input_count: p.input_count,
            fee_rate_sat_vb: p.fee_rate_sat_vb,
            expires_at_ms: p.expires_at_ms,
        })
    })
    .await
}

/// The user-approval act: reached only from the confirm button of the bundled UI.
#[tauri::command]
async fn confirm_send(
    h: tauri::State<'_, WalletHandle>,
    plan_id: String,
) -> Result<SentDto, String> {
    h.run(move |w| {
        let r = w.confirm_send(&plan_id).map_err(err)?;
        Ok(SentDto { txid: r.txid })
    })
    .await
}

#[tauri::command]
async fn cancel_send(h: tauri::State<'_, WalletHandle>, plan_id: String) -> Result<bool, String> {
    h.run(move |w| Ok(w.cancel_send(&plan_id))).await
}

fn main() {
    tauri::Builder::default()
        .register_asynchronous_uri_scheme_protocol("tlapi", |ctx, request, responder| {
            match ctx.app_handle().try_state::<legacy::Bridge>() {
                Some(bridge) => bridge.serve(request, responder),
                None => responder.respond(legacy::unavailable()),
            }
        })
        .setup(|app| {
            let config_path = match std::env::var_os("TL_DESKTOP_CONFIG") {
                Some(p) => PathBuf::from(p),
                None => app.path().app_config_dir()?.join("config.json"),
            };
            let data_dir = app.path().app_data_dir()?;
            let node_dir =
                legacy::default_node_dir(&app.path().data_dir()?, &app.path().home_dir()?);
            app.manage(legacy::start(config::load_legacy(&config_path), node_dir)?);
            app.manage(start_wallet_thread(config_path, data_dir)?);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            status,
            create_wallet,
            import_wallet,
            unlock,
            lock,
            receive_address,
            balance,
            prepare_send,
            confirm_send,
            cancel_send
        ])
        .run(tauri::generate_context!())
        .expect("tauri runtime failed to start");
}
