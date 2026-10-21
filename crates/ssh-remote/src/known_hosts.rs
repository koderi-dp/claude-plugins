//! Auto-trusting known-hosts store: one `host:port SHA256:...` line per host.

use std::io;
use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostKeyStatus {
    New,
    Match,
    Changed { old: String, new: String },
}

#[derive(Debug, Clone)]
pub struct KnownHosts {
    path: PathBuf,
}

impl KnownHosts {
    /// `%LOCALAPPDATA%\ssh-remote\known_hosts`, falling back to the temp dir.
    pub fn default_path() -> PathBuf {
        let base = std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        base.join("ssh-remote").join("known_hosts")
    }

    pub fn new(path: PathBuf) -> KnownHosts {
        KnownHosts { path }
    }

    pub fn check_and_record(
        &self,
        host: &str,
        port: u16,
        fingerprint: &str,
    ) -> io::Result<HostKeyStatus> {
        let key = format!("{host}:{port}");
        let existing = match std::fs::read_to_string(&self.path) {
            Ok(s) => s,
            Err(e) if e.kind() == io::ErrorKind::NotFound => String::new(),
            Err(e) => return Err(e),
        };

        let mut status = HostKeyStatus::New;
        let mut lines: Vec<String> = Vec::new();
        for line in existing.lines() {
            match line.split_once(' ') {
                Some((k, fp)) if k == key => {
                    let fp = fp.trim();
                    if fp == fingerprint {
                        return Ok(HostKeyStatus::Match);
                    }
                    status = HostKeyStatus::Changed {
                        old: fp.to_string(),
                        new: fingerprint.to_string(),
                    };
                }
                _ => {
                    if !line.trim().is_empty() {
                        lines.push(line.to_string());
                    }
                }
            }
        }
        lines.push(format!("{key} {fingerprint}"));

        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut out = lines.join("\n");
        out.push('\n');
        std::fs::write(&self.path, out)?;
        Ok(status)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (tempfile::TempDir, KnownHosts) {
        let dir = tempfile::tempdir().unwrap();
        let kh = KnownHosts::new(dir.path().join("known_hosts"));
        (dir, kh)
    }

    #[test]
    fn first_seen_is_new_then_match() {
        let (_d, kh) = store();
        assert_eq!(kh.check_and_record("h", 22, "SHA256:A").unwrap(), HostKeyStatus::New);
        assert_eq!(kh.check_and_record("h", 22, "SHA256:A").unwrap(), HostKeyStatus::Match);
    }

    #[test]
    fn changed_returns_old_and_replaces() {
        let (_d, kh) = store();
        kh.check_and_record("h", 22, "A").unwrap();
        assert_eq!(
            kh.check_and_record("h", 22, "B").unwrap(),
            HostKeyStatus::Changed { old: "A".into(), new: "B".into() }
        );
        assert_eq!(kh.check_and_record("h", 22, "B").unwrap(), HostKeyStatus::Match);
    }

    #[test]
    fn ports_are_separate() {
        let (_d, kh) = store();
        assert_eq!(kh.check_and_record("h", 22, "A").unwrap(), HostKeyStatus::New);
        assert_eq!(kh.check_and_record("h", 2222, "B").unwrap(), HostKeyStatus::New);
        assert_eq!(kh.check_and_record("h", 22, "A").unwrap(), HostKeyStatus::Match);
        assert_eq!(kh.check_and_record("h", 2222, "B").unwrap(), HostKeyStatus::Match);
    }

    #[test]
    fn keeps_other_hosts() {
        let (_d, kh) = store();
        kh.check_and_record("a", 22, "A").unwrap();
        kh.check_and_record("b", 22, "B").unwrap();
        kh.check_and_record("c", 22, "C").unwrap();
        kh.check_and_record("b", 22, "B2").unwrap();
        assert_eq!(kh.check_and_record("a", 22, "A").unwrap(), HostKeyStatus::Match);
        assert_eq!(kh.check_and_record("b", 22, "B2").unwrap(), HostKeyStatus::Match);
        assert_eq!(kh.check_and_record("c", 22, "C").unwrap(), HostKeyStatus::Match);
    }

    #[test]
    fn creates_parent_dir() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("x").join("y").join("known_hosts");
        let kh = KnownHosts::new(path.clone());
        kh.check_and_record("h", 22, "A").unwrap();
        assert_eq!(std::fs::read_to_string(path).unwrap(), "h:22 A\n");
    }
}
