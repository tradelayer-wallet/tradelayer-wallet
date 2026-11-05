//! Optional `tradelayer-rpcd` / `tradelayer-listenerd` sidecar.
//!
//! Started only when the config names `tl_engine = "tradelayer-rust"` and a `tl_engine_cmd`, or
//! `tl_engine = "tradelayer-listenerd"` with a `tl_listenerd` object;
//! otherwise [`Sidecar::from_settings`] returns `None` and no process is ever spawned. One
//! supervisor thread owns the child: it restarts it with exponential backoff when it exits, and
//! [`Sidecar::stop`] (the app's exit hook, also `Drop`) stops it and joins the thread: a child
//! with a stop file (`tradelayer-listenerd --stop-file`) is asked to exit by creating the file and
//! is killed only when it is still running after `stop_grace`; any other child is killed at once.
//!
//! The child gets no stdin and no console window; its stderr is read by a second thread that
//! keeps the last line for [`Sidecar::status`]. A hard crash of the app cannot run the exit
//! hook (`#![forbid(unsafe_code)]` rules out a Windows job object), so rpcd, which is read-only
//! and loopback-only, could outlive it; the next start finds its port busy and backs off.

use crate::engine::{Engine, EngineSettings};
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

/// How the supervisor waits between starts.
#[derive(Clone, Copy, Debug)]
pub struct Backoff {
    /// First delay after an exit.
    pub base: Duration,
    /// Delay ceiling; each consecutive failure doubles the delay up to this.
    pub max: Duration,
    /// A child that ran at least this long was healthy: the next delay is `base` again.
    pub stable_after: Duration,
}

impl Default for Backoff {
    fn default() -> Backoff {
        Backoff {
            base: Duration::from_millis(500),
            max: Duration::from_secs(30),
            stable_after: Duration::from_secs(60),
        }
    }
}

impl Backoff {
    fn next(&self, current: Duration, ran_for: Duration) -> Duration {
        if ran_for >= self.stable_after {
            self.base
        } else {
            (current * 2).min(self.max)
        }
    }
}

/// What to run.
#[derive(Clone, Debug)]
pub struct Spec {
    pub cmd: PathBuf,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    /// The file the child exits on when it appears (`tradelayer-listenerd --stop-file`). The
    /// supervisor removes a stale one before each start (the daemon refuses to start with one),
    /// [`Sidecar::stop`] creates it, and a child that exits with it present is not restarted.
    pub stop_file: Option<PathBuf>,
    /// How long [`Sidecar::stop`] waits for the child to exit after creating the stop file
    /// before it kills it.
    pub stop_grace: Duration,
}

const POLL: Duration = Duration::from_millis(50);
const MAX_STDERR_LINE: usize = 512;

/// Snapshot for tests and diagnostics.
#[cfg(test)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Status {
    /// A child process is alive right now.
    pub running: bool,
    /// Times the child was started (the first start counts).
    pub starts: u32,
    /// Last line the child wrote to stderr, or the last spawn error.
    pub last_message: String,
}

struct Shared {
    stop: AtomicBool,
    starts: AtomicU32,
    child: Mutex<Option<Child>>,
    last_message: Mutex<String>,
}

pub struct Sidecar {
    shared: Arc<Shared>,
    join: Mutex<Option<JoinHandle<()>>>,
    stop_file: Option<PathBuf>,
    stop_grace: Duration,
}

impl Sidecar {
    /// The sidecar the config asks for: `None` unless the engine is `tradelayer-rust` or `tradelayer-listenerd`
    /// and the config names the command to run.
    pub fn from_settings(s: &EngineSettings) -> Option<std::io::Result<Sidecar>> {
        if !matches!(s.engine, Engine::TradelayerRust | Engine::Listenerd) {
            return None;
        }
        let cmd = s.cmd.clone()?;
        Some(Sidecar::start(
            Spec {
                cmd,
                args: s.args.clone(),
                env: Vec::new(),
                stop_file: s.stop_file.clone(),
                stop_grace: s.stop_grace,
            },
            Backoff::default(),
        ))
    }

    pub fn start(spec: Spec, backoff: Backoff) -> std::io::Result<Sidecar> {
        let shared = Arc::new(Shared {
            stop: AtomicBool::new(false),
            starts: AtomicU32::new(0),
            child: Mutex::new(None),
            last_message: Mutex::new(String::new()),
        });
        let s = shared.clone();
        let (stop_file, stop_grace) = (spec.stop_file.clone(), spec.stop_grace);
        let join = std::thread::Builder::new()
            .name("tl-engine".into())
            .spawn(move || supervise(&s, &spec, backoff))?;
        Ok(Sidecar {
            shared,
            join: Mutex::new(Some(join)),
            stop_file,
            stop_grace,
        })
    }

    #[cfg(test)]
    pub fn status(&self) -> Status {
        Status {
            running: self
                .shared
                .child
                .lock()
                .map(|c| c.is_some())
                .unwrap_or(false),
            starts: self.shared.starts.load(Ordering::SeqCst),
            last_message: self
                .shared
                .last_message
                .lock()
                .map(|m| m.clone())
                .unwrap_or_default(),
        }
    }

    /// Stop restarting, kill the child and wait for the supervisor. Safe to call twice.
    pub fn stop(&self) {
        self.shared.stop.store(true, Ordering::SeqCst);
        let handle = self.join.lock().ok().and_then(|mut j| j.take());
        // a child with a stop file is asked to exit first and killed only after the grace period
        let asked = self
            .stop_file
            .as_ref()
            .is_some_and(|f| std::fs::write(f, b"stop").is_ok());
        if asked {
            let end = Instant::now() + self.stop_grace;
            while Instant::now() < end && handle.as_ref().is_some_and(|h| !h.is_finished()) {
                std::thread::sleep(POLL);
            }
        }
        if let Ok(mut c) = self.shared.child.lock() {
            if let Some(child) = c.as_mut() {
                let _ = child.kill();
            }
        }
        if let Some(h) = handle {
            let _ = h.join();
        }
        if let Some(f) = &self.stop_file {
            let _ = std::fs::remove_file(f);
        }
    }
}

impl Drop for Sidecar {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Tauri state: the app's sidecar, if one was configured.
pub struct EngineProcess(pub Mutex<Option<Sidecar>>);

impl EngineProcess {
    pub fn stop(&self) {
        let taken = self.0.lock().ok().and_then(|mut s| s.take());
        if let Some(s) = taken {
            s.stop();
        }
    }
}

fn set_message(shared: &Shared, m: String) {
    if let Ok(mut l) = shared.last_message.lock() {
        *l = m;
    }
}

fn command(spec: &Spec) -> Command {
    let mut c = Command::new(&spec.cmd);
    c.args(&spec.args)
        .envs(spec.env.iter().map(|(k, v)| (k, v)))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW
        c.creation_flags(0x0800_0000);
    }
    c
}

/// Sleep `d`, or less if the sidecar is stopped. Returns true when stopped.
fn pause(shared: &Shared, d: Duration) -> bool {
    let end = Instant::now() + d;
    while Instant::now() < end {
        if shared.stop.load(Ordering::SeqCst) {
            return true;
        }
        std::thread::sleep(POLL.min(end.saturating_duration_since(Instant::now())));
    }
    shared.stop.load(Ordering::SeqCst)
}

fn supervise(shared: &Arc<Shared>, spec: &Spec, backoff: Backoff) {
    let mut delay = backoff.base;
    while !shared.stop.load(Ordering::SeqCst) {
        let started = Instant::now();
        // the daemon refuses to start while a stop file exists
        if let Some(f) = &spec.stop_file {
            let _ = std::fs::remove_file(f);
        }
        match command(spec).spawn() {
            Ok(mut child) => {
                shared.starts.fetch_add(1, Ordering::SeqCst);
                let reader = child.stderr.take().map(|e| {
                    let s = shared.clone();
                    std::thread::spawn(move || {
                        for line in BufReader::new(e).lines().map_while(Result::ok) {
                            let mut line = line;
                            line.truncate(MAX_STDERR_LINE);
                            set_message(&s, line);
                        }
                    })
                });
                if let Ok(mut slot) = shared.child.lock() {
                    *slot = Some(child);
                }
                // stop() may have run between the check above and publishing the child
                if shared.stop.load(Ordering::SeqCst) {
                    if let Ok(mut slot) = shared.child.lock() {
                        if let Some(c) = slot.as_mut() {
                            let _ = c.kill();
                        }
                    }
                }
                wait_for_exit(shared);
                if let Ok(mut slot) = shared.child.lock() {
                    *slot = None;
                }
                if let Some(r) = reader {
                    let _ = r.join();
                }
                // exited with its stop file present: someone asked it to stop, so it stays down
                if let Some(f) = spec.stop_file.as_ref().filter(|f| f.exists()) {
                    let _ = std::fs::remove_file(f);
                    set_message(shared, "stopped through its stop file".into());
                    shared.stop.store(true, Ordering::SeqCst);
                    break;
                }
            }
            Err(e) => set_message(shared, format!("spawn {}: {e}", spec.cmd.display())),
        }
        delay = backoff.next(delay, started.elapsed());
        if pause(shared, delay) {
            break;
        }
    }
}

/// Poll the child until it exits (or is killed by `stop`).
fn wait_for_exit(shared: &Shared) {
    loop {
        let exited = match shared.child.lock() {
            Ok(mut slot) => match slot.as_mut() {
                Some(c) => !matches!(c.try_wait(), Ok(None)),
                None => true,
            },
            Err(_) => true,
        };
        if exited {
            return;
        }
        std::thread::sleep(POLL);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    /// Not a test: the process the supervisor starts. Run by `current_exe --exact` with
    /// `TL_SIDECAR_HELPER` naming a mode and `TL_SIDECAR_LOG` a file that records each start.
    #[test]
    fn helper_child() {
        let Ok(mode) = std::env::var("TL_SIDECAR_HELPER") else {
            return;
        };
        if let Ok(log) = std::env::var("TL_SIDECAR_LOG") {
            use std::io::Write;
            let mut f = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(log)
                .unwrap();
            let _ = writeln!(f, "start");
        }
        eprintln!("helper up: {mode}");
        match mode.as_str() {
            "exit1" => std::process::exit(1),
            // like tradelayer-listenerd: serve until the stop file exists, then exit 0
            "stopfile" => {
                let file = std::env::var("TL_SIDECAR_STOPFILE").unwrap();
                while !std::path::Path::new(&file).exists() {
                    std::thread::sleep(Duration::from_millis(20));
                }
                if let Ok(log) = std::env::var("TL_SIDECAR_LOG") {
                    use std::io::Write;
                    let mut f = std::fs::OpenOptions::new().append(true).open(log).unwrap();
                    let _ = writeln!(f, "clean-exit");
                }
                std::process::exit(0);
            }
            _ => std::thread::sleep(Duration::from_secs(120)),
        }
    }

    fn spec(mode: &str, log: &std::path::Path) -> Spec {
        Spec {
            cmd: std::env::current_exe().unwrap(),
            args: [
                "--exact",
                "engine_sidecar::tests::helper_child",
                "--nocapture",
            ]
            .map(String::from)
            .to_vec(),
            env: vec![
                ("TL_SIDECAR_HELPER".into(), mode.into()),
                ("TL_SIDECAR_LOG".into(), log.to_string_lossy().into_owned()),
            ],
            stop_file: None,
            stop_grace: Duration::from_secs(5),
        }
    }

    /// [`spec`] whose child exits when `stop_file` appears (mode `stopfile`), or ignores it
    /// (any other mode).
    fn spec_with_stop_file(
        mode: &str,
        log: &std::path::Path,
        stop_file: &std::path::Path,
        grace: Duration,
    ) -> Spec {
        let mut s = spec(mode, log);
        s.env.push((
            "TL_SIDECAR_STOPFILE".into(),
            stop_file.to_string_lossy().into_owned(),
        ));
        s.stop_file = Some(stop_file.to_path_buf());
        s.stop_grace = grace;
        s
    }

    fn fast() -> Backoff {
        Backoff {
            base: Duration::from_millis(50),
            max: Duration::from_millis(400),
            stable_after: Duration::from_secs(60),
        }
    }

    fn starts_in(log: &std::path::Path) -> usize {
        std::fs::read_to_string(log)
            .map(|t| t.lines().filter(|l| *l == "start").count())
            .unwrap_or(0)
    }

    fn wait_until(what: &str, mut f: impl FnMut() -> bool) {
        let end = Instant::now() + Duration::from_secs(20);
        while Instant::now() < end {
            if f() {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        panic!("timed out waiting for {what}");
    }

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("tl-sidecar-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn nothing_starts_unless_configured() {
        assert!(Sidecar::from_settings(&EngineSettings::default()).is_none());
        // the engine without a command: the user runs rpcd themselves
        let s = EngineSettings {
            engine: Engine::TradelayerRust,
            ..EngineSettings::default()
        };
        assert!(Sidecar::from_settings(&s).is_none());
        // a command with the default engine is rejected by config validation, and ignored here
        let s = EngineSettings {
            cmd: Some(PathBuf::from("/x")),
            ..EngineSettings::default()
        };
        assert!(Sidecar::from_settings(&s).is_none());
        // listenerd without the tl_listenerd object: the user runs the daemon
        let s = EngineSettings {
            engine: Engine::Listenerd,
            ..EngineSettings::default()
        };
        assert!(Sidecar::from_settings(&s).is_none());
    }

    #[test]
    fn backoff_doubles_to_the_ceiling_and_resets_after_a_stable_run() {
        let b = Backoff {
            base: Duration::from_millis(100),
            max: Duration::from_millis(500),
            stable_after: Duration::from_secs(10),
        };
        let short = Duration::from_millis(1);
        let d1 = b.next(b.base, short);
        let d2 = b.next(d1, short);
        let d3 = b.next(d2, short);
        let d4 = b.next(d3, short);
        assert_eq!(
            [d1, d2, d3, d4].map(|d| d.as_millis()),
            [200, 400, 500, 500]
        );
        assert_eq!(b.next(d4, Duration::from_secs(10)), b.base);
    }

    #[test]
    fn a_child_that_dies_is_restarted_with_backoff_and_stop_ends_it() {
        let dir = tmp("restart");
        let log = dir.join("starts.log");
        let sc = Sidecar::start(spec("exit1", &log), fast()).unwrap();
        wait_until("three starts", || starts_in(&log) >= 3);
        assert!(sc.status().starts >= 3);
        sc.stop();
        let after = starts_in(&log);
        std::thread::sleep(Duration::from_millis(600));
        assert_eq!(starts_in(&log), after, "restarted after stop");
        assert!(!sc.status().running);
        sc.stop(); // twice is fine
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_running_child_is_killed_by_stop_and_its_stderr_is_kept() {
        let dir = tmp("run");
        let log = dir.join("starts.log");
        let sc = Sidecar::start(spec("sleep", &log), fast()).unwrap();
        wait_until("child up", || {
            let s = sc.status();
            s.running && s.last_message.contains("helper up: sleep")
        });
        let started = Instant::now();
        sc.stop();
        assert!(started.elapsed() < Duration::from_secs(10));
        assert!(!sc.status().running);
        assert_eq!(starts_in(&log), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_binary_is_reported_and_retried_without_panicking() {
        let spec = Spec {
            cmd: std::env::temp_dir().join("tl-sidecar-no-such-binary.exe"),
            args: vec![],
            env: vec![],
            stop_file: None,
            stop_grace: Duration::from_secs(5),
        };
        let sc = Sidecar::start(spec, fast()).unwrap();
        wait_until("spawn error", || {
            sc.status().last_message.starts_with("spawn ")
        });
        assert_eq!(sc.status().starts, 0);
        drop(sc); // Drop stops it
    }

    #[test]
    fn a_child_with_a_stop_file_is_asked_to_exit_and_not_killed() {
        let dir = tmp("graceful");
        let log = dir.join("starts.log");
        let stop = dir.join("stop");
        // a stale stop file from an earlier run must not stop the new child
        std::fs::write(&stop, b"stale").unwrap();
        let sc = Sidecar::start(
            spec_with_stop_file("stopfile", &log, &stop, Duration::from_secs(10)),
            fast(),
        )
        .unwrap();
        wait_until("child up", || sc.status().running && starts_in(&log) == 1);
        std::thread::sleep(Duration::from_millis(300));
        assert!(sc.status().running, "the stale stop file stopped the child");
        let started = Instant::now();
        sc.stop();
        assert!(started.elapsed() < Duration::from_secs(8));
        let text = std::fs::read_to_string(&log).unwrap();
        assert!(text.lines().any(|l| l == "clean-exit"), "{text}");
        assert_eq!(starts_in(&log), 1);
        assert!(!stop.exists(), "the stop file is removed after the stop");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_child_that_ignores_its_stop_file_is_killed_after_the_grace_period() {
        let dir = tmp("stubborn");
        let log = dir.join("starts.log");
        let stop = dir.join("stop");
        let sc = Sidecar::start(
            spec_with_stop_file("sleep", &log, &stop, Duration::from_millis(400)),
            fast(),
        )
        .unwrap();
        wait_until("child up", || sc.status().running);
        let started = Instant::now();
        sc.stop();
        let took = started.elapsed();
        assert!(took >= Duration::from_millis(400), "{took:?}");
        assert!(took < Duration::from_secs(10), "{took:?}");
        assert!(!sc.status().running);
        assert!(!stop.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_child_stopped_through_its_stop_file_from_outside_stays_down() {
        let dir = tmp("outside");
        let log = dir.join("starts.log");
        let stop = dir.join("stop");
        let sc = Sidecar::start(
            spec_with_stop_file("stopfile", &log, &stop, Duration::from_secs(5)),
            fast(),
        )
        .unwrap();
        wait_until("child up", || sc.status().running && starts_in(&log) == 1);
        std::fs::write(&stop, b"stop").unwrap();
        wait_until("child gone", || {
            !sc.status().running && sc.status().last_message.contains("stop file")
        });
        std::thread::sleep(Duration::from_millis(500));
        assert_eq!(starts_in(&log), 1, "restarted after an operator stop");
        assert!(!stop.exists());
        sc.stop();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn engine_process_stop_is_idempotent() {
        let p = EngineProcess(Mutex::new(None));
        p.stop();
        let dir = tmp("proc");
        let log = dir.join("starts.log");
        let p = EngineProcess(Mutex::new(Some(
            Sidecar::start(spec("sleep", &log), fast()).unwrap(),
        )));
        wait_until("child up", || starts_in(&log) >= 1);
        p.stop();
        p.stop();
        assert!(p.0.lock().unwrap().is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
