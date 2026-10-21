//! SFTP download with a size cap.

use std::path::{Path, PathBuf};

use tokio::io::AsyncReadExt;

use crate::format::size;
use crate::session::Session;

/// `%TEMP%\ssh-remote\<host>\<last component of remote>`; falls back to `download` when the
/// remote path has no file name (`download` itself refuses such paths).
pub fn default_local_path(host: &str, remote: &str) -> PathBuf {
    let name = remote.rsplit('/').next().unwrap_or("");
    std::env::temp_dir()
        .join("ssh-remote")
        .join(safe_component(host, "_"))
        .join(safe_component(name, "download"))
}

/// Turns arbitrary text into one safe Windows path component: separators, wildcards and control
/// characters become `_`, trailing dots and spaces go, `.`/`..`/empty become `fallback`, and
/// reserved device names get a `_` prefix.
fn safe_component(text: &str, fallback: &str) -> String {
    let cleaned: String = text
        .chars()
        .map(|c| {
            if c.is_control() || r#"\/:*?"<>|"#.contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let trimmed = cleaned.trim_end_matches(['.', ' ']);
    if trimmed.is_empty() {
        return fallback.to_string();
    }
    let stem = trimmed
        .split('.')
        .next()
        .unwrap_or("")
        .trim_end()
        .to_ascii_uppercase();
    let reserved = matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || ((stem.starts_with("COM") || stem.starts_with("LPT"))
        && stem.len() == 4
        && stem.as_bytes()[3].is_ascii_digit());
    if reserved {
        format!("_{trimmed}")
    } else {
        trimmed.to_string()
    }
}

/// The cap as shown to the user: whole megabytes as `200 MB`, anything else via `size`.
fn cap_text(cap: u64) -> String {
    const MB: u64 = 1024 * 1024;
    if cap >= MB && cap.is_multiple_of(MB) {
        format!("{} MB", cap / MB)
    } else {
        size(cap)
    }
}

/// Downloads `remote` to `local` (creating parent directories), refusing files over `cap` bytes.
/// Data goes to a `.part` file next to `local` and is renamed into place on success.
pub async fn download(s: &Session, remote: &str, local: &Path, cap: u64) -> Result<u64, String> {
    if remote.is_empty() || remote.ends_with('/') {
        return Err(format!("remote path {remote} has no file name"));
    }
    let sftp = s.sftp().await?;
    let result = fetch(&sftp, remote, local, cap).await;
    let _ = sftp.close().await;
    result
}

async fn fetch(
    sftp: &russh_sftp::client::SftpSession,
    remote: &str,
    local: &Path,
    cap: u64,
) -> Result<u64, String> {
    let too_big = |n: u64| {
        format!(
            "remote file {remote} is {}; limit is {}",
            size(n),
            cap_text(cap)
        )
    };
    let meta = sftp
        .metadata(remote)
        .await
        .map_err(|e| format!("cannot stat {remote}: {e}"))?;
    if meta.is_dir() {
        return Err(format!("{remote} is a directory"));
    }
    if let Some(n) = meta.size
        && n > cap
    {
        return Err(too_big(n));
    }
    let file = sftp
        .open(remote)
        .await
        .map_err(|e| format!("cannot open {remote}: {e}"))?;

    if let Some(dir) = local.parent() {
        tokio::fs::create_dir_all(dir)
            .await
            .map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    }
    let mut part_name = local.file_name().unwrap_or_default().to_os_string();
    part_name.push(".part");
    let part = local.with_file_name(part_name);

    let copied = copy_capped(file, &part, cap).await;
    match copied {
        Ok(Some(n)) => tokio::fs::rename(&part, local)
            .await
            .map(|_| n)
            .map_err(|e| {
                let _ = std::fs::remove_file(&part);
                format!("cannot write {}: {e}", local.display())
            }),
        Ok(None) => {
            let _ = tokio::fs::remove_file(&part).await;
            Err(format!(
                "remote file {remote} is larger than the limit of {}",
                cap_text(cap)
            ))
        }
        Err(e) => {
            let _ = tokio::fs::remove_file(&part).await;
            Err(format!(
                "cannot download {remote} to {}: {e}",
                local.display()
            ))
        }
    }
}

/// Streams `src` into `part`; `None` when it turned out to exceed `cap`.
async fn copy_capped(
    src: impl tokio::io::AsyncRead + Unpin,
    part: &Path,
    cap: u64,
) -> std::io::Result<Option<u64>> {
    let mut out = tokio::fs::File::create(part).await?;
    let n = tokio::io::copy(&mut src.take(cap.saturating_add(1)), &mut out).await?;
    tokio::io::AsyncWriteExt::flush(&mut out).await?;
    Ok((n <= cap).then_some(n))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_path_shape() {
        let p = default_local_path("10.0.0.21", "/var/log/syslog");
        assert!(p.ends_with(Path::new("ssh-remote").join("10.0.0.21").join("syslog")));
    }

    fn base(host: &str) -> PathBuf {
        std::env::temp_dir().join("ssh-remote").join(host)
    }

    #[test]
    fn default_path_sanitises_windows_specials() {
        for (remote, name) in [
            (r"/tmp/C:\x\evil*", "C__x_evil_"),
            (r"/tmp/..\..\x", ".._.._x"),
            ("/tmp/a?b|c", "a_b_c"),
            ("/tmp/name. .", "name"),
            ("/tmp/..", "download"),
            ("/tmp/", "download"),
        ] {
            let p = default_local_path("h", remote);
            assert_eq!(p.parent().unwrap(), base("h"), "{remote}");
            assert_eq!(p.file_name().unwrap().to_str().unwrap(), name, "{remote}");
        }
    }

    #[test]
    fn default_path_reserved_name() {
        let p = default_local_path("h", "/tmp/CON");
        assert_eq!(p, base("h").join("_CON"));
        assert_eq!(
            default_local_path("h", "/tmp/nul.txt"),
            base("h").join("_nul.txt")
        );
        assert_eq!(
            default_local_path("h", "/tmp/com1"),
            base("h").join("_com1")
        );
    }

    #[test]
    fn default_path_ipv6_host() {
        let p = default_local_path("fe80::1", "/tmp/f");
        assert_eq!(p, base("fe80__1").join("f"));
        assert_eq!(p.parent().unwrap(), base("fe80__1"));
    }
}
