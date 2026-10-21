//! Renders command and download results: header, trimming, masking, full-output file.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::known_hosts::HostKeyStatus;
use crate::secret::{Secret, mask_all};

pub struct ExecOutcome {
    pub user: String,
    pub host: String,
    pub exit: Option<u32>,
    pub elapsed: Duration,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub timed_out: Option<u64>,
    pub key_status: HostKeyStatus,
}

pub fn render_exec(
    o: &ExecOutcome,
    max_lines: usize,
    secrets: &[&Secret],
    full_dir: &Path,
) -> String {
    let stdout = mask_all(secrets, &String::from_utf8_lossy(&o.stdout));
    let stderr = mask_all(secrets, &String::from_utf8_lossy(&o.stderr));
    let (shown_out, trimmed_out) = trim_lines(&stdout, max_lines);
    let (shown_err, trimmed_err) = trim_lines(&stderr, max_lines);

    let mut out = String::new();
    if let HostKeyStatus::Changed { old, new } = &o.key_status {
        out.push_str(&format!(
            "warning: host key for {} changed ({old} → {new}), accepted
",
            o.host
        ));
    }
    let status = match (o.timed_out, o.exit) {
        (Some(s), _) => format!("timed out after {s} s"),
        (None, Some(code)) => format!("exit {code}"),
        (None, None) => "no exit status".to_string(),
    };
    out.push_str(&format!(
        "{}@{} · {status} · {}",
        o.user,
        o.host,
        secs(o.elapsed)
    ));
    push_section(&mut out, &shown_out);
    if !stderr.is_empty() {
        out.push_str("
--- stderr ---");
        push_section(&mut out, &shown_err);
    }
    if trimmed_out || trimmed_err {
        let mut full = stdout;
        if !stderr.is_empty() {
            if !full.is_empty() && !full.ends_with('\n') {
                full.push('\n');
            }
            full.push_str("--- stderr ---
");
            full.push_str(&stderr);
        }
        match write_full(full_dir, &full) {
            Ok(path) => out.push_str(&format!("
full output: {}", path.display())),
            Err(e) => out.push_str(&format!("
full output: not saved ({e})")),
        }
    }
    out
}

pub fn render_download(
    remote: &str,
    local: &Path,
    bytes: u64,
    elapsed: Duration,
    key_status: &HostKeyStatus,
) -> String {
    // The host is not part of this signature, so the changed-key warning
    // cannot be rendered here; the caller prepends it if needed.
    let _ = key_status;
    format!(
        "downloaded {remote} → {} ({}, {})",
        local.display(),
        size(bytes),
        secs(elapsed)
    )
}

fn push_section(out: &mut String, text: &str) {
    if !text.is_empty() {
        out.push('\n');
        out.push_str(text.strip_suffix('\n').unwrap_or(text));
    }
}

fn secs(d: Duration) -> String {
    format!("{:.1} s", d.as_secs_f64())
}

fn size(bytes: u64) -> String {
    const KB: f64 = 1024.0;
    let b = bytes as f64;
    if b < KB {
        format!("{bytes} B")
    } else if b < KB * KB {
        format!("{:.1} KB", b / KB)
    } else {
        format!("{:.1} MB", b / (KB * KB))
    }
}

/// Keeps the first `max_lines / 2` and last `max_lines - max_lines / 2` lines
/// when there are more than `max_lines`. Returns the text and whether it was cut.
fn trim_lines(text: &str, max_lines: usize) -> (String, bool) {
    let lines: Vec<&str> = text.lines().collect();
    if lines.len() <= max_lines {
        return (text.to_string(), false);
    }
    let head = max_lines / 2;
    let tail = max_lines - head;
    let omitted = lines.len() - head - tail;
    let mut parts: Vec<String> = lines[..head].iter().map(|l| l.to_string()).collect();
    parts.push(format!("… {omitted} lines omitted …"));
    parts.extend(lines[lines.len() - tail..].iter().map(|l| l.to_string()));
    (parts.join("
"), true)
}

/// Writes `content` to a new `<YYYYMMDD-HHMMSS>[-n].log` in `dir`, never overwriting.
fn write_full(dir: &Path, content: &str) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(dir)?;
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
    for n in 0u32.. {
        let name = if n == 0 {
            format!("{stamp}.log")
        } else {
            format!("{stamp}-{n}.log")
        };
        let path = dir.join(name);
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut f) => {
                f.write_all(content.as_bytes())?;
                return Ok(path);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    unreachable!()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secret::Secret;
    use std::path::PathBuf;

    fn outcome() -> ExecOutcome {
        ExecOutcome {
            user: "root".into(),
            host: "10.0.0.21".into(),
            exit: Some(0),
            elapsed: Duration::from_millis(400),
            stdout: b"hello\n".to_vec(),
            stderr: Vec::new(),
            timed_out: None,
            key_status: HostKeyStatus::Match,
        }
    }

    fn numbered(n: usize) -> Vec<u8> {
        (1..=n).map(|i| format!("{i}\n")).collect::<String>().into_bytes()
    }

    fn secret(text: &str) -> (tempfile::TempDir, Secret) {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("s");
        std::fs::write(&p, text).unwrap();
        let s = Secret::from_file(&p).unwrap();
        (d, s)
    }

    fn files(dir: &Path) -> Vec<PathBuf> {
        match std::fs::read_dir(dir) {
            Ok(rd) => rd.map(|e| e.unwrap().path()).collect(),
            Err(_) => Vec::new(),
        }
    }

    #[test]
    fn header_shape() {
        let d = tempfile::tempdir().unwrap();
        let out = render_exec(&outcome(), 200, &[], d.path());
        assert!(out.starts_with("root@10.0.0.21 · exit 0 · 0.4 s"), "{out}");
        assert!(out.contains("hello"));
    }

    #[test]
    fn no_trim_under_limit() {
        let d = tempfile::tempdir().unwrap();
        let full = d.path().join("full");
        let mut o = outcome();
        o.stdout = numbered(10);
        let out = render_exec(&o, 200, &[], &full);
        assert!(!out.contains("full output:"));
        assert!(!out.contains("omitted"));
        for i in 1..=10 {
            assert!(out.lines().any(|l| l == i.to_string()));
        }
        assert!(files(&full).is_empty());
    }

    #[test]
    fn trims_head_and_tail() {
        let d = tempfile::tempdir().unwrap();
        let full = d.path().join("sub").join("host");
        let mut o = outcome();
        o.stdout = numbered(1000);
        let out = render_exec(&o, 200, &[], &full);
        let lines: Vec<&str> = out.lines().collect();
        let i = lines.iter().position(|l| *l == "… 800 lines omitted …").unwrap();
        assert_eq!(lines[i - 1], "100");
        assert_eq!(lines[i - 100], "1");
        assert_eq!(lines[i + 1], "901");
        assert_eq!(lines[i + 100], "1000");
        assert!(!lines.contains(&"500"));
        let path_line = lines.iter().find(|l| l.starts_with("full output: ")).unwrap();
        let path = PathBuf::from(path_line.trim_start_matches("full output: "));
        assert!(path.starts_with(&full));
        assert_eq!(path.extension().unwrap(), "log");
        let saved = std::fs::read_to_string(&path).unwrap();
        assert_eq!(saved.lines().count(), 1000);
    }

    #[test]
    fn stderr_section_only_when_nonempty() {
        let d = tempfile::tempdir().unwrap();
        let out = render_exec(&outcome(), 200, &[], d.path());
        assert!(!out.contains("--- stderr ---"));
        let mut o = outcome();
        o.stderr = b"boom\n".to_vec();
        let out = render_exec(&o, 200, &[], d.path());
        let at = out.find("--- stderr ---").unwrap();
        assert!(out[at..].contains("boom"));
        assert!(out.find("hello").unwrap() < at);
    }

    #[test]
    fn timeout_marker() {
        let d = tempfile::tempdir().unwrap();
        let mut o = outcome();
        o.exit = None;
        o.timed_out = Some(60);
        let out = render_exec(&o, 200, &[], d.path());
        let first = out.lines().next().unwrap();
        assert_eq!(first, "root@10.0.0.21 · timed out after 60 s · 0.4 s");
        assert!(!out.contains("exit"));
    }

    #[test]
    fn changed_key_warning_first_line() {
        let d = tempfile::tempdir().unwrap();
        let mut o = outcome();
        o.key_status =
            HostKeyStatus::Changed { old: "SHA256:old".into(), new: "SHA256:new".into() };
        let out = render_exec(&o, 200, &[], d.path());
        assert_eq!(
            out.lines().next().unwrap(),
            "warning: host key for 10.0.0.21 changed (SHA256:old → SHA256:new), accepted"
        );
        assert!(out.lines().nth(1).unwrap().starts_with("root@10.0.0.21 · exit 0"));
    }

    #[test]
    fn masks_after_trim_and_in_file() {
        let (_sd, s) = secret("hunter2\n");
        let d = tempfile::tempdir().unwrap();
        let mut o = outcome();
        let text: String = (1..=1000)
            .map(|i| match i {
                1 | 500 => format!("pw is hunter2 {i}\n"),
                _ => format!("{i}\n"),
            })
            .collect();
        o.stdout = text.into_bytes();
        let out = render_exec(&o, 200, &[&s], d.path());
        assert!(!out.contains("hunter2"));
        assert!(out.contains("pw is *** 1"));
        let all: Vec<PathBuf> = files(d.path());
        assert_eq!(all.len(), 1);
        let saved = std::fs::read_to_string(&all[0]).unwrap();
        assert!(!saved.contains("hunter2"));
        assert!(saved.contains("pw is *** 500"));
    }

    #[test]
    fn secret_across_stdout_stderr_is_masked_in_each() {
        let (_sd, s) = secret("hunter2");
        let d = tempfile::tempdir().unwrap();
        let mut o = outcome();
        o.stdout = b"out hunter2\n".to_vec();
        o.stderr = b"err hunter2\n".to_vec();
        let out = render_exec(&o, 200, &[&s], d.path());
        assert!(!out.contains("hunter2"));
        assert!(out.contains("out ***"));
        assert!(out.contains("err ***"));
    }

    #[test]
    fn lossy_utf8() {
        let d = tempfile::tempdir().unwrap();
        let mut o = outcome();
        o.stdout = vec![0xff, b'o', b'k'];
        let out = render_exec(&o, 200, &[], d.path());
        assert!(out.contains("ok"));
    }

    #[test]
    fn same_second_files_do_not_collide() {
        let d = tempfile::tempdir().unwrap();
        let mut o = outcome();
        o.stdout = numbered(1000);
        render_exec(&o, 200, &[], d.path());
        render_exec(&o, 200, &[], d.path());
        render_exec(&o, 200, &[], d.path());
        assert_eq!(files(d.path()).len(), 3);
    }

    #[test]
    fn download_line() {
        let out = render_download(
            "/var/log/syslog",
            Path::new(r"C:\x\syslog"),
            2_516_582,
            Duration::from_millis(800),
            &HostKeyStatus::Match,
        );
        assert_eq!(out, r"downloaded /var/log/syslog → C:\x\syslog (2.4 MB, 0.8 s)");
    }

    #[test]
    fn download_small_and_kb_sizes() {
        let st = HostKeyStatus::New;
        let out = render_download("/f", Path::new("g"), 512, Duration::from_millis(0), &st);
        assert_eq!(out, "downloaded /f → g (512 B, 0.0 s)");
        let out = render_download("/f", Path::new("g"), 1536, Duration::from_millis(0), &st);
        assert_eq!(out, "downloaded /f → g (1.5 KB, 0.0 s)");
    }
}
