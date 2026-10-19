//! Full-log store: saves the untrimmed output under the temp dir.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Logs older than this are pruned on each save.
pub const MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);

pub fn default_dir() -> PathBuf {
    std::env::temp_dir().join("output-trim")
}

/// `YYYYMMDD-HHMMSS` in UTC for a unix timestamp (civil-from-days algorithm).
fn timestamp(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}{m:02}{d:02}-{:02}{:02}{:02}",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

/// Writes `text` to a new timestamped `.log` file in `dir` (created if
/// missing), then prunes logs older than 24 hours.
pub fn save(dir: &Path, text: &str) -> io::Result<PathBuf> {
    fs::create_dir_all(dir)?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let stamp = timestamp(now.as_secs());
    let mut nonce = now.subsec_nanos();
    let mut attempt = 0;
    let (path, mut file) = loop {
        let path = dir.join(format!("{stamp}-{:04x}.log", nonce & 0xffff));
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(f) => break (path, f),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists && attempt < 16 => {
                attempt += 1;
                nonce = nonce.wrapping_mul(1_103_515_245).wrapping_add(12_345);
            }
            Err(e) => return Err(e),
        }
    };
    file.write_all(text.as_bytes())?;
    prune(dir, MAX_AGE);
    Ok(path)
}

/// Deletes `*.log` files in `dir` older than `max_age`; errors are ignored.
pub fn prune(dir: &Path, max_age: Duration) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().is_none_or(|e| e != "log") {
            continue;
        }
        let age = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| SystemTime::now().duration_since(t).ok());
        if age.is_some_and(|a| a >= max_age) {
            let _ = fs::remove_file(&path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn save_round_trips() {
        let d = tempfile::tempdir().unwrap();
        let p = save(d.path(), "hello\nworld").unwrap();
        assert!(p.exists());
        assert_eq!(p.extension().unwrap(), "log");
        assert_eq!(fs::read_to_string(&p).unwrap(), "hello\nworld");
        let name = p.file_name().unwrap().to_str().unwrap();
        // YYYYMMDD-HHMMSS-xxxx.log
        assert_eq!(name.len(), 8 + 1 + 6 + 1 + 4 + 4);
    }

    #[test]
    fn save_creates_missing_dir() {
        let d = tempfile::tempdir().unwrap();
        let sub = d.path().join("a").join("b");
        assert!(save(&sub, "x").unwrap().exists());
    }

    #[test]
    fn prune_deletes_old_logs_only() {
        let d = tempfile::tempdir().unwrap();
        let log = save(d.path(), "x").unwrap();
        let txt = d.path().join("keep.txt");
        fs::write(&txt, "x").unwrap();
        std::thread::sleep(Duration::from_millis(20));
        prune(d.path(), Duration::ZERO);
        assert!(!log.exists());
        assert!(txt.exists());
    }

    #[test]
    fn prune_keeps_recent_logs() {
        let d = tempfile::tempdir().unwrap();
        let log = save(d.path(), "x").unwrap();
        prune(d.path(), Duration::from_secs(3600));
        assert!(log.exists());
    }
}
