//! Bounded table of pending send plans.
//!
//! Pure bookkeeping, generic over the stored value, so the rules can be tested and modelled
//! (`lean/TlDesktopCore/Session.lean`) without keys or a node:
//!
//! * at most [`MAX_PENDING_PLANS`] entries;
//! * an entry is live while `now < expires_at_ms` (exclusive, like the signing capability);
//! * [`PlanTable::take`] removes the entry whether or not it is still live, so an id can be
//!   confirmed at most once.

use crate::config::MAX_PENDING_PLANS;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InsertError {
    /// The table holds [`MAX_PENDING_PLANS`] live entries.
    Full,
    /// A live entry already has this id.
    Duplicate,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TakeError {
    Unknown,
    /// The entry existed, was removed, and had expired.
    Expired,
}

#[derive(Debug)]
struct Entry<T> {
    id: String,
    expires_at_ms: u64,
    value: T,
}

#[derive(Debug)]
pub struct PlanTable<T> {
    entries: Vec<Entry<T>>,
}

impl<T> Default for PlanTable<T> {
    fn default() -> Self {
        PlanTable {
            entries: Vec::new(),
        }
    }
}

impl<T> PlanTable<T> {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Drop every entry that is no longer live.
    pub fn purge_expired(&mut self, now_ms: u64) {
        self.entries.retain(|e| now_ms < e.expires_at_ms);
    }

    /// Purge expired entries, then add one. Fails when the table is full or the id is taken.
    pub fn insert(
        &mut self,
        id: String,
        expires_at_ms: u64,
        value: T,
        now_ms: u64,
    ) -> Result<(), InsertError> {
        self.purge_expired(now_ms);
        if self.entries.len() >= MAX_PENDING_PLANS {
            return Err(InsertError::Full);
        }
        if self.entries.iter().any(|e| e.id == id) {
            return Err(InsertError::Duplicate);
        }
        self.entries.push(Entry {
            id,
            expires_at_ms,
            value,
        });
        Ok(())
    }

    /// Remove the entry `id` and return it if it was still live.
    pub fn take(&mut self, id: &str, now_ms: u64) -> Result<T, TakeError> {
        let pos = self
            .entries
            .iter()
            .position(|e| e.id == id)
            .ok_or(TakeError::Unknown)?;
        let e = self.entries.remove(pos);
        if now_ms < e.expires_at_ms {
            Ok(e.value)
        } else {
            Err(TakeError::Expired)
        }
    }

    /// Remove the entry `id`; true if one was removed.
    pub fn remove(&mut self, id: &str) -> bool {
        let before = self.entries.len();
        self.entries.retain(|e| e.id != id);
        self.entries.len() != before
    }

    pub fn clear(&mut self) {
        self.entries.clear();
    }

    pub fn values(&self) -> impl Iterator<Item = &T> {
        self.entries.iter().map(|e| &e.value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TTL: u64 = 120_000;

    fn id(n: u64) -> String {
        format!("p{n}")
    }

    // The decide-vectors of `lean/TlDesktopCore/Session.lean` (`vec_*`).

    #[test]
    fn vec_confirm_once() {
        let mut t = PlanTable::new();
        t.insert(id(0), TTL, (), 0).unwrap();
        assert_eq!(t.take(&id(0), 1_000), Ok(()));
        assert_eq!(t.take(&id(0), 1_000), Err(TakeError::Unknown));
    }

    #[test]
    fn vec_expiry_boundary_is_exclusive() {
        let mut t = PlanTable::new();
        t.insert(id(0), TTL, (), 0).unwrap();
        assert_eq!(t.take(&id(0), TTL - 1), Ok(()));
        t.insert(id(1), TTL, (), 0).unwrap();
        assert_eq!(t.take(&id(1), TTL), Err(TakeError::Expired));
        assert!(t.is_empty());
    }

    #[test]
    fn vec_ninth_plan_is_refused_and_expired_ones_make_room() {
        let mut t = PlanTable::new();
        for n in 0..8 {
            t.insert(id(n), TTL, (), 0).unwrap();
        }
        assert_eq!(t.insert(id(8), TTL, (), 0), Err(InsertError::Full));
        assert_eq!(t.len(), 8);
        assert_eq!(t.insert(id(8), 2 * TTL, (), TTL), Ok(()));
        assert_eq!(t.len(), 1);
    }

    #[test]
    fn vec_clear_empties() {
        let mut t = PlanTable::new();
        t.insert(id(0), TTL, (), 0).unwrap();
        t.insert(id(1), TTL, (), 0).unwrap();
        t.clear();
        assert!(t.is_empty());
        assert_eq!(t.take(&id(0), 1), Err(TakeError::Unknown));
    }

    #[test]
    fn duplicate_ids_and_remove() {
        let mut t = PlanTable::new();
        t.insert(id(0), TTL, 1u8, 0).unwrap();
        assert_eq!(t.insert(id(0), TTL, 2u8, 0), Err(InsertError::Duplicate));
        assert!(t.remove(&id(0)));
        assert!(!t.remove(&id(0)));
        assert_eq!(t.values().count(), 0);
    }

    #[test]
    fn purge_keeps_live_entries_only() {
        let mut t = PlanTable::new();
        t.insert(id(0), 10, (), 0).unwrap();
        t.insert(id(1), 20, (), 0).unwrap();
        t.purge_expired(10);
        assert_eq!(t.len(), 1);
        t.purge_expired(20);
        assert!(t.is_empty());
    }
}
