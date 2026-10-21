//! Open sessions keyed by `user@host:port`, so follow-up calls reuse a connection without
//! re-reading credential files.
//!
//! Locking is per entry: the map lock is held only to find or create an entry, so calls to
//! different hosts run concurrently while calls to the same `user@host:port` take turns.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::Mutex;

use crate::known_hosts::{HostKeyStatus, KnownHosts};
use crate::secret::{Secret, mask_all};
use crate::session::{Creds, Session, Target};

struct Entry {
    session: Session,
    /// The newest credentials; reconnects use these.
    creds: Creds,
    /// Secrets of credentials replaced by later calls. The session may still be logged in with
    /// one of them, so they keep masking output until the entry is dropped.
    retired: Vec<Secret>,
    last_used: Instant,
}

impl Entry {
    /// Replaces the credentials, keeping the old secrets for masking.
    fn replace_creds(&mut self, new: Creds) {
        let old = std::mem::replace(&mut self.creds, new);
        self.retired.extend(old.password);
        self.retired.extend(old.key.and_then(|(_, p)| p));
    }

    /// Every secret this entry has held.
    fn secrets(&self) -> Vec<&Secret> {
        let mut all = creds_secrets(&self.creds);
        all.extend(self.retired.iter());
        all
    }
}

/// The password and key passphrase in `c`.
fn creds_secrets(c: &Creds) -> Vec<&Secret> {
    c.password
        .iter()
        .chain(c.key.as_ref().and_then(|(_, p)| p.as_ref()))
        .collect()
}

/// One map slot. `None` while the first connect is pending, or after an entry was dropped.
type Slot = Arc<Mutex<Option<Entry>>>;

pub struct Pool {
    known: KnownHosts,
    idle: Duration,
    entries: Mutex<HashMap<String, Slot>>,
}

/// The pool key: `user@host:port`.
pub fn key(t: &Target) -> String {
    format!("{}@{}:{}", t.user, t.host, t.port)
}

impl Pool {
    pub fn new(known: KnownHosts, idle: Duration) -> Pool {
        Pool {
            known,
            idle,
            entries: Mutex::new(HashMap::new()),
        }
    }

    /// Runs `f` on the open session for `t`, connecting first when there is none or it has
    /// closed. `creds`, when given, replace the stored ones for reconnects; the replaced secrets
    /// stay with the entry. `f` gets every secret the entry has held, so the caller can mask its
    /// output; the secrets never leave the pool. Errors, the pool's own and `f`'s, come back
    /// masked with that same set.
    pub async fn with_session<T>(
        &self,
        t: &Target,
        creds: Option<Creds>,
        f: impl AsyncFnOnce(&Session, &[&Secret]) -> Result<T, String>,
    ) -> Result<T, String> {
        let k = key(t);
        let (slot, mut guard) = self.lock_entry(&k).await;

        if let Some(entry) = guard.as_mut() {
            if let Some(new) = creds {
                entry.replace_creds(new);
            }
            if entry.session.is_closed() {
                // Reconnect once; on failure the entry and its secrets go.
                match Session::connect(t, &entry.creds, &self.known).await {
                    Ok(s) => entry.session = s,
                    Err(e) => {
                        let e = mask_all(&entry.secrets(), &e);
                        *guard = None;
                        self.remove_slot(&k, &slot).await;
                        return Err(e);
                    }
                }
            }
        } else {
            let Some(new) = creds else {
                self.remove_slot(&k, &slot).await;
                return Err(format!(
                    "no credentials for {}@{}: pass password_file or key_file",
                    t.user, t.host
                ));
            };
            match Session::connect(t, &new, &self.known).await {
                Ok(session) => {
                    *guard = Some(Entry {
                        session,
                        creds: new,
                        retired: Vec::new(),
                        last_used: Instant::now(),
                    })
                }
                Err(e) => {
                    let e = mask_all(&creds_secrets(&new), &e);
                    self.remove_slot(&k, &slot).await;
                    return Err(e);
                }
            }
        }

        let entry = guard.as_mut().expect("entry present after connect");
        let secrets = entry.secrets();
        let result = f(&entry.session, &secrets)
            .await
            .map_err(|e| mask_all(&secrets, &e));
        // The connect-time host-key status is reported once, by the first call that succeeds;
        // later calls on this connection see `Match`. A failed call keeps it, so a changed-key
        // warning is not lost to an error.
        if result.is_ok() {
            entry.session.key_status = HostKeyStatus::Match;
        }
        entry.last_used = Instant::now();
        result
    }

    /// Drops idle entries, then finds or creates the slot for `k` and locks it. Retries when
    /// the slot was removed from the map while this call waited for it.
    async fn lock_entry(&self, k: &str) -> (Slot, tokio::sync::OwnedMutexGuard<Option<Entry>>) {
        loop {
            let slot = {
                let mut map = self.entries.lock().await;
                self.expire(&mut map);
                map.entry(k.to_string()).or_default().clone()
            };
            let guard = slot.clone().lock_owned().await;
            let current = self.entries.lock().await.get(k).cloned();
            if current.is_some_and(|c| Arc::ptr_eq(&c, &slot)) {
                return (slot, guard);
            }
        }
    }

    /// Removes entries idle longer than `idle`. A slot that is locked is in use and stays.
    fn expire(&self, map: &mut HashMap<String, Slot>) {
        let now = Instant::now();
        map.retain(|_, slot| match slot.try_lock() {
            Ok(mut entry) => {
                if entry
                    .as_ref()
                    .is_some_and(|e| now.duration_since(e.last_used) > self.idle)
                {
                    *entry = None;
                    false
                } else {
                    true
                }
            }
            Err(_) => true,
        });
    }

    async fn remove_slot(&self, k: &str, slot: &Slot) {
        let mut map = self.entries.lock().await;
        if map.get(k).is_some_and(|c| Arc::ptr_eq(c, slot)) {
            map.remove(k);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t() -> Target {
        Target {
            host: "10.0.0.21".into(),
            port: 22,
            user: "root".into(),
        }
    }

    #[test]
    fn key_format() {
        assert_eq!(key(&t()), "root@10.0.0.21:22");
    }

    #[tokio::test]
    async fn missing_creds_error() {
        let d = tempfile::tempdir().unwrap();
        let pool = Pool::new(
            KnownHosts::new(d.path().join("known_hosts")),
            Duration::from_secs(300),
        );
        let err = pool
            .with_session(&t(), None, async |_s, _secrets| Ok(()))
            .await
            .err()
            .unwrap();
        assert_eq!(
            err,
            "no credentials for root@10.0.0.21: pass password_file or key_file"
        );
    }
}
