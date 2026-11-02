//! Vault storage on the filesystem.
//!
//! [`FileStore`] keeps one file per vault key inside one directory. Every write goes to a
//! temporary file in the same directory, is flushed to disk, and replaces the target with a
//! rename, so a crash leaves either the old value or the new one, never a partial file. The
//! compare-and-swap of [`VaultStore`] is a read, a comparison and that atomic write; it is atomic
//! against crashes, and against other threads through `&mut self`, but not against a second
//! process using the same directory (the desktop shell runs one instance).

use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use tl_wallet_core::vault::{StoreError, VaultStore};

/// In-memory store for tests (re-export of `tl-wallet-core`'s `MemoryStore`).
pub use tl_wallet_core::vault::MemoryStore as InMemoryStore;

const VALUE_SUFFIX: &str = ".val";
/// Largest value file read back (a sealed vault is a few hundred bytes).
const MAX_VALUE_BYTES: u64 = 1 << 20;
const MAX_KEY_BYTES: usize = 200;

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone)]
pub struct FileStore {
    dir: PathBuf,
}

/// Injective, filesystem-safe file name for a key: ASCII letters, digits, `_`, `-` and a
/// non-leading `.` stay; every other byte becomes `%XX`.
fn encode_key(key: &str) -> Option<String> {
    if key.is_empty() || key.len() > MAX_KEY_BYTES {
        return None;
    }
    let mut out = String::with_capacity(key.len() + VALUE_SUFFIX.len());
    for (i, b) in key.bytes().enumerate() {
        let plain = b.is_ascii_alphanumeric() || b == b'_' || b == b'-' || (b == b'.' && i > 0);
        if plain {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out.push_str(VALUE_SUFFIX);
    Some(out)
}

fn decode_key(file_name: &str) -> Option<String> {
    let stem = file_name.strip_suffix(VALUE_SUFFIX)?;
    let bytes = stem.as_bytes();
    let mut raw = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = stem.get(i + 1..i + 3)?;
            raw.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            raw.push(bytes[i]);
            i += 1;
        }
    }
    let key = String::from_utf8(raw).ok()?;
    // Only canonical names count: anything `encode_key` would not produce is not a key.
    (encode_key(&key).as_deref() == Some(file_name)).then_some(key)
}

impl FileStore {
    /// Use `dir` as the store, creating it (and parents) if needed.
    pub fn open(dir: impl Into<PathBuf>) -> Result<Self, StoreError> {
        let dir = dir.into();
        fs::create_dir_all(&dir).map_err(|_| StoreError::Io)?;
        Ok(FileStore { dir })
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn path_for(&self, key: &str) -> Result<PathBuf, StoreError> {
        let name = encode_key(key).ok_or(StoreError::Io)?;
        Ok(self.dir.join(name))
    }

    fn read_value(path: &Path) -> Result<Option<String>, StoreError> {
        let file = match File::open(path) {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(StoreError::Io),
        };
        let mut text = String::new();
        file.take(MAX_VALUE_BYTES + 1)
            .read_to_string(&mut text)
            .map_err(|_| StoreError::Io)?;
        if text.len() as u64 > MAX_VALUE_BYTES {
            return Err(StoreError::Io);
        }
        Ok(Some(text))
    }

    /// Write `value` to `target` atomically: temp file in the same directory, flush to disk,
    /// rename over the target (`std::fs::rename` replaces an existing file on Windows too).
    fn write_atomic(&self, target: &Path, value: &str) -> Result<(), StoreError> {
        let n = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let tmp = self.dir.join(format!(".tmp-{}-{n}", std::process::id()));
        let result = (|| -> std::io::Result<()> {
            let mut f = File::create(&tmp)?;
            f.write_all(value.as_bytes())?;
            f.sync_all()?;
            drop(f);
            fs::rename(&tmp, target)?;
            sync_dir(&self.dir);
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&tmp);
        }
        result.map_err(|_| StoreError::Io)
    }
}

/// Persist the rename itself. Directories cannot be opened for syncing on Windows, where the
/// rename is made durable by the filesystem journal; best effort elsewhere.
fn sync_dir(dir: &Path) {
    #[cfg(unix)]
    if let Ok(d) = File::open(dir) {
        let _ = d.sync_all();
    }
    #[cfg(not(unix))]
    let _ = dir;
}

impl VaultStore for FileStore {
    fn get(&self, key: &str) -> Result<Option<String>, StoreError> {
        Self::read_value(&self.path_for(key)?)
    }

    fn compare_and_swap(
        &mut self,
        key: &str,
        expected: Option<&str>,
        new: Option<&str>,
    ) -> Result<(), StoreError> {
        let path = self.path_for(key)?;
        let current = Self::read_value(&path)?;
        if current.as_deref() != expected {
            return Err(StoreError::Conflict);
        }
        match new {
            Some(v) => self.write_atomic(&path, v),
            None => match fs::remove_file(&path) {
                Ok(()) => {
                    sync_dir(&self.dir);
                    Ok(())
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(_) => Err(StoreError::Io),
            },
        }
    }

    fn keys(&self) -> Result<Vec<String>, StoreError> {
        let mut keys = Vec::new();
        for entry in fs::read_dir(&self.dir).map_err(|_| StoreError::Io)? {
            let entry = entry.map_err(|_| StoreError::Io)?;
            if let Some(key) = entry.file_name().to_str().and_then(decode_key) {
                keys.push(key);
            }
        }
        keys.sort();
        Ok(keys)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);
    impl TempDir {
        fn new(tag: &str) -> Self {
            let n = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
            let p = std::env::temp_dir()
                .join(format!("tl-desktop-core-{tag}-{}-{n}", std::process::id()));
            TempDir(p)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn set_get_replace_delete() {
        let d = TempDir::new("crud");
        let mut s = FileStore::open(&d.0).unwrap();
        assert_eq!(s.get("vault.v1"), Ok(None));
        s.compare_and_swap("vault.v1", None, Some("one")).unwrap();
        assert_eq!(s.get("vault.v1").unwrap().as_deref(), Some("one"));
        s.compare_and_swap("vault.v1", Some("one"), Some("two"))
            .unwrap();
        assert_eq!(s.get("vault.v1").unwrap().as_deref(), Some("two"));
        s.compare_and_swap("vault.v1", Some("two"), None).unwrap();
        assert_eq!(s.get("vault.v1"), Ok(None));
        // deleting an absent key with `expected = None` is not an error
        s.compare_and_swap("vault.v1", None, None).unwrap();
    }

    #[test]
    fn compare_and_swap_conflict_writes_nothing() {
        let d = TempDir::new("cas");
        let mut s = FileStore::open(&d.0).unwrap();
        s.compare_and_swap("k", None, Some("a")).unwrap();
        assert_eq!(
            s.compare_and_swap("k", None, Some("b")),
            Err(StoreError::Conflict)
        );
        assert_eq!(
            s.compare_and_swap("k", Some("zzz"), Some("b")),
            Err(StoreError::Conflict)
        );
        assert_eq!(
            s.compare_and_swap("k", Some("zzz"), None),
            Err(StoreError::Conflict)
        );
        assert_eq!(s.get("k").unwrap().as_deref(), Some("a"));
    }

    #[test]
    fn values_survive_reopening() {
        let d = TempDir::new("reopen");
        {
            let mut s = FileStore::open(&d.0).unwrap();
            s.compare_and_swap("vault.v1", None, Some("sealed"))
                .unwrap();
        }
        let s = FileStore::open(&d.0).unwrap();
        assert_eq!(s.get("vault.v1").unwrap().as_deref(), Some("sealed"));
    }

    #[test]
    fn writes_leave_no_temporary_files() {
        let d = TempDir::new("tmp");
        let mut s = FileStore::open(&d.0).unwrap();
        for i in 0..5 {
            let v = format!("v{i}");
            let prev = if i == 0 {
                None
            } else {
                Some(format!("v{}", i - 1))
            };
            s.compare_and_swap("k", prev.as_deref(), Some(&v)).unwrap();
        }
        let names: Vec<String> = fs::read_dir(&d.0)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(names, vec!["k.val".to_string()]);
    }

    #[test]
    fn stray_temp_files_are_not_keys() {
        let d = TempDir::new("stray");
        let mut s = FileStore::open(&d.0).unwrap();
        s.compare_and_swap("a", None, Some("1")).unwrap();
        fs::write(d.0.join(".tmp-1-1"), "partial").unwrap();
        fs::write(d.0.join("note.txt"), "x").unwrap();
        assert_eq!(s.keys().unwrap(), vec!["a".to_string()]);
    }

    #[test]
    fn awkward_keys_are_encoded_not_traversed() {
        let d = TempDir::new("keys");
        let mut s = FileStore::open(&d.0).unwrap();
        let keys = [
            "encryptedPrivateKey:abc",
            "../escape",
            "a/b\\c",
            ".hidden",
            "ünï",
            "with space",
        ];
        for (i, k) in keys.iter().enumerate() {
            s.compare_and_swap(k, None, Some(&format!("v{i}"))).unwrap();
        }
        for (i, k) in keys.iter().enumerate() {
            assert_eq!(s.get(k).unwrap().as_deref(), Some(format!("v{i}").as_str()));
        }
        let mut want: Vec<String> = keys.iter().map(|k| k.to_string()).collect();
        want.sort();
        assert_eq!(s.keys().unwrap(), want);
        // nothing was written outside the directory
        assert!(!d.0.parent().unwrap().join("escape.val").exists());
        assert_eq!(fs::read_dir(&d.0).unwrap().count(), keys.len());
    }

    #[test]
    fn empty_and_oversized_keys_are_rejected() {
        let d = TempDir::new("badkey");
        let mut s = FileStore::open(&d.0).unwrap();
        assert_eq!(s.get(""), Err(StoreError::Io));
        let long = "k".repeat(MAX_KEY_BYTES + 1);
        assert_eq!(
            s.compare_and_swap(&long, None, Some("x")),
            Err(StoreError::Io)
        );
    }

    #[test]
    fn oversized_value_file_is_an_error() {
        let d = TempDir::new("big");
        let s = FileStore::open(&d.0).unwrap();
        let big = vec![b'a'; (MAX_VALUE_BYTES + 1) as usize];
        fs::write(d.0.join("k.val"), big).unwrap();
        assert_eq!(s.get("k"), Err(StoreError::Io));
    }

    #[test]
    fn key_encoding_round_trips() {
        for k in ["vault.v1", "a:b", "%41", ".x", "x.", "é"] {
            let f = encode_key(k).unwrap();
            assert_eq!(decode_key(&f).as_deref(), Some(k), "{k}");
        }
        assert_eq!(decode_key("%zz.val"), None);
        assert_eq!(decode_key("%41.val"), None);
        assert_eq!(decode_key("x"), None);
    }
}
