//! Renders command and download results: header, trimming, masking, full-output file.

use std::collections::VecDeque;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::known_hosts::HostKeyStatus;
use crate::secret::{Secret, mask_all};

/// Bytes kept at each end of a stream; a stream is captured up to twice this.
pub const CAPTURE_HALF: usize = 32 * 1024 * 1024;
/// Characters shown per stream after line trimming.
pub const MAX_CHARS: usize = 100_000;

pub struct ExecOutcome {
    pub user: String,
    pub host: String,
    pub exit: Option<u32>,
    /// The signal that killed the command, without the `SIG` prefix.
    pub signal: Option<String>,
    pub elapsed: Duration,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    /// Where `stdout` lost its middle to the capture cap, if it did.
    pub stdout_cut: Option<Cut>,
    pub stderr_cut: Option<Cut>,
    pub timed_out: Option<u64>,
    pub key_status: HostKeyStatus,
}

/// A gap in captured bytes: `dropped` bytes were discarded at offset `at`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cut {
    pub at: usize,
    pub dropped: u64,
}

/// Captures a stream, keeping the first `half` bytes and a ring buffer of the last `half`.
pub struct Capture {
    half: usize,
    head: Vec<u8>,
    tail: VecDeque<u8>,
    dropped: u64,
}

impl Capture {
    pub fn new(half: usize) -> Capture {
        Capture {
            half,
            head: Vec::new(),
            tail: VecDeque::new(),
            dropped: 0,
        }
    }

    pub fn push(&mut self, mut data: &[u8]) {
        if self.head.len() < self.half {
            let n = (self.half - self.head.len()).min(data.len());
            self.head.extend_from_slice(&data[..n]);
            data = &data[n..];
        }
        if data.len() > self.half {
            // Everything before the last `half` bytes of `data` goes, old tail included.
            let skip = data.len() - self.half;
            self.dropped += (self.tail.len() + skip) as u64;
            self.tail.clear();
            data = &data[skip..];
        }
        self.tail.extend(data);
        let excess = self.tail.len().saturating_sub(self.half);
        self.tail.drain(..excess);
        self.dropped += excess as u64;
    }

    /// The captured bytes and where the middle was dropped, if it was.
    pub fn finish(self) -> (Vec<u8>, Option<Cut>) {
        let at = self.head.len();
        let mut bytes = self.head;
        bytes.extend(self.tail);
        let cut = (self.dropped > 0).then_some(Cut {
            at,
            dropped: self.dropped,
        });
        (bytes, cut)
    }
}

pub fn render_exec(
    o: &ExecOutcome,
    max_lines: usize,
    secrets: &[&Secret],
    full_dir: &Path,
) -> String {
    // Masking runs on the whole captured text, before any trimming.
    let stdout = captured_text(&o.stdout, o.stdout_cut, secrets);
    let stderr = captured_text(&o.stderr, o.stderr_cut, secrets);
    let (shown_out, trimmed_out) = trim(&stdout, max_lines);
    let (shown_err, trimmed_err) = trim(&stderr, max_lines);

    let mut out = String::new();
    out.push_str(&key_warning(&o.host, &o.key_status));
    let status = match (o.timed_out, &o.signal, o.exit) {
        (Some(s), _, _) => format!("timed out after {s} s"),
        (None, Some(sig), _) => format!("killed by SIG{sig}"),
        (None, None, Some(code)) => format!("exit {code}"),
        (None, None, None) => "no exit status".to_string(),
    };
    out.push_str(&format!(
        "{}@{} · {status} · {}",
        o.user,
        o.host,
        secs(o.elapsed)
    ));
    push_section(&mut out, &shown_out);
    if !stderr.is_empty() {
        out.push_str(
            "
--- stderr ---",
        );
        push_section(&mut out, &shown_err);
    }
    if trimmed_out || trimmed_err {
        let mut full = stdout;
        if !stderr.is_empty() {
            if !full.is_empty() && !full.ends_with('\n') {
                full.push('\n');
            }
            full.push_str(
                "--- stderr ---
",
            );
            full.push_str(&stderr);
        }
        match write_full(full_dir, &full) {
            Ok(path) => out.push_str(&format!(
                "
full output: {}",
                path.display()
            )),
            Err(e) => out.push_str(&format!(
                "
full output: not saved ({e})"
            )),
        }
    }
    out
}

pub fn render_download(
    host: &str,
    remote: &str,
    local: &Path,
    bytes: u64,
    elapsed: Duration,
    key_status: &HostKeyStatus,
) -> String {
    format!(
        "{}downloaded {remote} → {} ({}, {})",
        key_warning(host, key_status),
        local.display(),
        size(bytes),
        secs(elapsed)
    )
}

/// The changed-host-key warning line (with trailing newline), or empty.
fn key_warning(host: &str, status: &HostKeyStatus) -> String {
    match status {
        HostKeyStatus::Changed { old, new } => {
            format!(
                "warning: host key for {host} changed ({old} → {new}), accepted
"
            )
        }
        _ => String::new(),
    }
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

pub(crate) fn size(bytes: u64) -> String {
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

/// Decodes and masks captured bytes. Around a capture cut, a secret may have been split, so a
/// partial secret ending the head or starting the tail is masked as well.
fn captured_text(bytes: &[u8], cut: Option<Cut>, secrets: &[&Secret]) -> String {
    let Some(cut) = cut else {
        return mask_all(secrets, &String::from_utf8_lossy(bytes));
    };
    let mut head = bytes[..cut.at].to_vec();
    let mut tail = bytes[cut.at..].to_vec();
    for s in secrets {
        let p = s.expose().as_bytes();
        if let Some(k) = (1..p.len()).rev().find(|&k| head.ends_with(&p[..k])) {
            head.truncate(head.len() - k);
            head.extend_from_slice(b"***");
        }
        if let Some(k) = (1..p.len())
            .rev()
            .find(|&k| tail.starts_with(&p[p.len() - k..]))
        {
            tail.splice(..k, *b"***");
        }
    }
    let mut out = mask_all(secrets, &String::from_utf8_lossy(&head));
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
    out.push_str(&format!("… {} bytes dropped …\n", cut.dropped));
    out.push_str(&mask_all(secrets, &String::from_utf8_lossy(&tail)));
    out
}

/// Line trimming, then character trimming. Returns the text and whether it was cut.
fn trim(text: &str, max_lines: usize) -> (String, bool) {
    let (lines, by_lines) = trim_lines(text, max_lines);
    let (shown, by_chars) = trim_chars(&lines, MAX_CHARS);
    (shown, by_lines || by_chars)
}

/// Keeps the first `max / 2` and last `max - max / 2` characters when there are more than
/// `max`, cutting on char boundaries. Returns the text and whether it was cut.
fn trim_chars(text: &str, max: usize) -> (String, bool) {
    let total = text.chars().count();
    if total <= max {
        return (text.to_string(), false);
    }
    let head = max / 2;
    let tail = max - head;
    let byte_at = |n: usize| text.char_indices().nth(n).map_or(text.len(), |(i, _)| i);
    let head_end = byte_at(head);
    let tail_start = byte_at(total - tail);
    let omitted = total - head - tail;
    (
        format!(
            "{}\n… {omitted} characters omitted …\n{}",
            &text[..head_end],
            &text[tail_start..]
        ),
        true,
    )
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
    (
        parts.join(
            "
",
        ),
        true,
    )
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
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
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
            signal: None,
            elapsed: Duration::from_millis(400),
            stdout: b"hello\n".to_vec(),
            stderr: Vec::new(),
            stdout_cut: None,
            stderr_cut: None,
            timed_out: None,
            key_status: HostKeyStatus::Match,
        }
    }

    fn capture(half: usize, chunks: &[&[u8]]) -> (Vec<u8>, Option<Cut>) {
        let mut c = Capture::new(half);
        for chunk in chunks {
            c.push(chunk);
        }
        c.finish()
    }

    #[test]
    fn capture_under_cap_keeps_everything() {
        assert_eq!(
            capture(4, &[b"abc", b"defgh"]),
            (b"abcdefgh".to_vec(), None)
        );
    }

    #[test]
    fn capture_keeps_head_and_tail_and_counts_dropped() {
        let (bytes, cut) = capture(4, &[b"ab", b"cdef", b"ghij", b"k"]);
        assert_eq!(bytes, b"abcdhijk");
        assert_eq!(cut, Some(Cut { at: 4, dropped: 3 }));
        // A chunk larger than the tail replaces it whole.
        let (bytes, cut) = capture(4, &[b"abcdef", b"0123456789"]);
        assert_eq!(bytes, b"abcd6789");
        assert_eq!(cut, Some(Cut { at: 4, dropped: 8 }));
    }

    #[test]
    fn capture_cap_bounds_memory() {
        let mut c = Capture::new(1024);
        let chunk = vec![b'x'; 300];
        for _ in 0..1000 {
            c.push(&chunk);
        }
        let (bytes, cut) = c.finish();
        assert_eq!(bytes.len(), 2048);
        assert_eq!(cut.unwrap().dropped, 300_000 - 2048);
    }

    #[test]
    fn dropped_bytes_marker_and_split_secret_masked() {
        let (_sd, s) = secret("hunter2");
        let d = tempfile::tempdir().unwrap();
        let mut o = outcome();
        // The head ends with the start of the secret, the tail starts with its end.
        let (bytes, cut) = capture(8, &[b"abcdhunt", b"XXXXXXXX", b"er2 tail"]);
        assert_eq!(bytes, b"abcdhunter2 tail");
        o.stdout = bytes;
        o.stdout_cut = cut;
        let out = render_exec(&o, 200, &[&s], d.path());
        assert!(
            out.contains("abcd***\n… 8 bytes dropped …\n*** tail"),
            "{out}"
        );
        assert!(!out.contains("hunt"), "{out}");
        assert!(!out.contains("er2"), "{out}");
    }

    #[test]
    fn long_single_line_trimmed_by_chars() {
        let d = tempfile::tempdir().unwrap();
        let mut o = outcome();
        o.stdout = vec![b'a'; 1_000_000];
        o.stdout.extend_from_slice(b"\n");
        let out = render_exec(&o, 200, &[], d.path());
        assert!(out.contains("… 900001 characters omitted …"));
        assert!(out.len() < MAX_CHARS + 1000, "{}", out.len());
        let path_line = out
            .lines()
            .find(|l| l.starts_with("full output: "))
            .unwrap();
        let path = PathBuf::from(path_line.trim_start_matches("full output: "));
        assert_eq!(std::fs::read(&path).unwrap().len(), 1_000_001);
    }

    #[test]
    fn char_trim_respects_char_boundaries_and_masks_first() {
        let (_sd, s) = secret("hunter2");
        let d = tempfile::tempdir().unwrap();
        let mut o = outcome();
        // The secret sits across the head/tail cut; it is masked before the cut.
        let mut text = "\u{e9}".repeat(MAX_CHARS / 2 - 3);
        text.push_str("hunter2");
        text.push_str(&"\u{fc}".repeat(MAX_CHARS));
        o.stdout = text.into_bytes();
        let out = render_exec(&o, 200, &[&s], d.path());
        assert!(!out.contains("hun"), "secret prefix survived");
        assert!(out.contains("characters omitted"));
    }

    fn numbered(n: usize) -> Vec<u8> {
        (1..=n)
            .map(|i| format!("{i}\n"))
            .collect::<String>()
            .into_bytes()
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
        let i = lines
            .iter()
            .position(|l| *l == "… 800 lines omitted …")
            .unwrap();
        assert_eq!(lines[i - 1], "100");
        assert_eq!(lines[i - 100], "1");
        assert_eq!(lines[i + 1], "901");
        assert_eq!(lines[i + 100], "1000");
        assert!(!lines.contains(&"500"));
        let path_line = lines
            .iter()
            .find(|l| l.starts_with("full output: "))
            .unwrap();
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
    fn signal_header() {
        let d = tempfile::tempdir().unwrap();
        let mut o = outcome();
        o.exit = None;
        o.signal = Some("KILL".into());
        let out = render_exec(&o, 200, &[], d.path());
        assert_eq!(
            out.lines().next().unwrap(),
            "root@10.0.0.21 · killed by SIGKILL · 0.4 s"
        );
    }

    #[test]
    fn changed_key_warning_first_line() {
        let d = tempfile::tempdir().unwrap();
        let mut o = outcome();
        o.key_status = HostKeyStatus::Changed {
            old: "SHA256:old".into(),
            new: "SHA256:new".into(),
        };
        let out = render_exec(&o, 200, &[], d.path());
        assert_eq!(
            out.lines().next().unwrap(),
            "warning: host key for 10.0.0.21 changed (SHA256:old → SHA256:new), accepted"
        );
        assert!(
            out.lines()
                .nth(1)
                .unwrap()
                .starts_with("root@10.0.0.21 · exit 0")
        );
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
            "h",
            "/var/log/syslog",
            Path::new(r"C:\x\syslog"),
            2_516_582,
            Duration::from_millis(800),
            &HostKeyStatus::Match,
        );
        assert_eq!(
            out,
            r"downloaded /var/log/syslog → C:\x\syslog (2.4 MB, 0.8 s)"
        );
    }

    #[test]
    fn download_changed_key_warning_first_line() {
        let st = HostKeyStatus::Changed {
            old: "SHA256:old".into(),
            new: "SHA256:new".into(),
        };
        let out = render_download("h", "/f", Path::new("g"), 1, Duration::from_millis(0), &st);
        assert_eq!(
            out,
            "warning: host key for h changed (SHA256:old → SHA256:new), accepted
downloaded /f → g (1 B, 0.0 s)"
        );
    }

    #[test]
    fn download_small_and_kb_sizes() {
        let st = HostKeyStatus::New;
        let out = render_download(
            "h",
            "/f",
            Path::new("g"),
            512,
            Duration::from_millis(0),
            &st,
        );
        assert_eq!(out, "downloaded /f → g (512 B, 0.0 s)");
        let out = render_download(
            "h",
            "/f",
            Path::new("g"),
            1536,
            Duration::from_millis(0),
            &st,
        );
        assert_eq!(out, "downloaded /f → g (1.5 KB, 0.0 s)");
    }
}
