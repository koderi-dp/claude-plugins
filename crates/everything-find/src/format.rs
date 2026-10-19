//! Compact grouped text output. Knows nothing about Everything or git.

use crate::filter::strip_root_ci;
use crate::pipeline::Entry;
use std::path::{Path, PathBuf};

pub struct Header {
    pub count: u32,
    pub count_is_lower_bound: bool,
    pub shown: usize,
    /// `repo C:\Source\app`, `C:\some\path` or `all drives`.
    pub scope_label: String,
    pub page_capped: bool,
    pub hidden_by_ignore: u32,
    pub indexing: bool,
}

pub fn render(entries: &[Entry], header: &Header, root: Option<&Path>, details: bool) -> String {
    let mut out = String::new();
    if header.indexing {
        out.push_str("Everything is still indexing; results may be incomplete.\n");
    }
    out.push_str(&header_line(header));
    out.push('\n');

    // Groups in order of first appearance; entries keep their sort order.
    let mut groups: Vec<(String, Vec<&Entry>)> = Vec::new();
    for e in entries {
        let key = group_key(e, root);
        match groups.iter_mut().find(|(k, _)| *k == key) {
            Some((_, list)) => list.push(e),
            None => groups.push((key, vec![e])),
        }
    }
    for (key, list) in groups {
        out.push_str(&key);
        out.push('\n');
        if details {
            for e in list {
                let mut line = format!("  {}", display_name(e));
                if let Some(size) = e.size.filter(|_| !e.is_dir) {
                    line.push_str(&format!("  {}", human_size(size)));
                }
                if let Some(ts) = e.modified.and_then(local_time) {
                    line.push_str(&format!("  {ts}"));
                }
                out.push_str(&line);
                out.push('\n');
            }
        } else {
            let names: Vec<String> = list.iter().map(|e| display_name(e)).collect();
            out.push_str(&format!("  {}\n", names.join("  ")));
        }
    }
    out
}

pub fn human_size(bytes: u64) -> String {
    const UNITS: [&str; 4] = ["KB", "MB", "GB", "TB"];
    if bytes < 1024 {
        return format!("{bytes} B");
    }
    let mut value = bytes as f64 / 1024.0;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    format!("{value:.1} {}", UNITS[unit])
}

fn header_line(h: &Header) -> String {
    let bound = if h.count_is_lower_bound { "≥" } else { "" };
    let limit = if (h.shown as u64) < h.count as u64 { " (limit)" } else { "" };
    let mut line = format!("{bound}{} matches, showing {}{limit} — {}", h.count, h.shown, h.scope_label);
    if h.page_capped {
        line.push_str(" (scan capped at 10 pages)");
    }
    if h.hidden_by_ignore > 0 {
        line.push_str(&format!(" ({} hidden by .gitignore — retry with include_ignored: true)", h.hidden_by_ignore));
    }
    line
}

fn group_key(e: &Entry, root: Option<&Path>) -> String {
    let parent = e.full_path.parent().unwrap_or(Path::new(""));
    let shown: PathBuf = match root.and_then(|r| strip_root_ci(parent, r)) {
        Some(rel) => rel,
        None => parent.to_path_buf(),
    };
    let s = shown.to_string_lossy().replace('\\', "/");
    let s = s.trim_end_matches('/');
    if s.is_empty() { "./".to_string() } else { format!("{s}/") }
}

fn display_name(e: &Entry) -> String {
    let name = e.full_path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    if e.is_dir { format!("{name}/") } else { name }
}

fn local_time(secs: i64) -> Option<String> {
    let utc = chrono::DateTime::from_timestamp(secs, 0)?;
    Some(utc.with_timezone(&chrono::Local).format("%Y-%m-%d %H:%M").to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(p: &str) -> Entry {
        Entry { full_path: PathBuf::from(p), is_dir: false, size: None, modified: None }
    }

    fn dir(p: &str) -> Entry {
        Entry { is_dir: true, ..file(p) }
    }

    fn hdr(count: u32, shown: usize, label: &str) -> Header {
        Header {
            count,
            count_is_lower_bound: false,
            shown,
            scope_label: label.to_string(),
            page_capped: false,
            hidden_by_ignore: 0,
            indexing: false,
        }
    }

    #[test]
    fn grouped_relative() {
        let e = [file(r"C:\r\src\b.rs"), file(r"C:\r\src\a.rs"), file(r"C:\r\README.md"), dir(r"C:\r\src\lib")];
        assert_eq!(
            render(&e, &hdr(4, 4, r"repo C:\r"), Some(Path::new(r"C:\r")), false),
            "4 matches, showing 4 — repo C:\\r\nsrc/\n  b.rs  a.rs  lib/\n./\n  README.md\n"
        );
    }

    #[test]
    fn truncated_lower_bound_hidden() {
        let e = [file(r"C:\r\a.rs")];
        let h = Header { count: 40, count_is_lower_bound: true, shown: 20, hidden_by_ignore: 3, ..hdr(0, 0, r"repo C:\r") };
        assert!(render(&e, &h, Some(Path::new(r"C:\r")), false).starts_with(
            "≥40 matches, showing 20 (limit) — repo C:\\r (3 hidden by .gitignore — retry with include_ignored: true)\n"
        ));
    }

    #[test]
    fn page_capped_note() {
        let h = Header { page_capped: true, ..hdr(5, 1, "all drives") };
        let out = render(&[file(r"C:\x\a")], &h, None, false);
        assert!(out.starts_with("5 matches, showing 1 (limit) — all drives (scan capped at 10 pages)\n"));
    }

    #[test]
    fn indexing_warning_first_line() {
        let h = Header { indexing: true, ..hdr(1, 1, "all drives") };
        let out = render(&[file(r"C:\x\a")], &h, None, false);
        assert!(out.starts_with("Everything is still indexing; results may be incomplete.\n1 matches"));
    }

    #[test]
    fn absolute_when_no_root() {
        let out = render(&[file(r"C:\x\y\z.txt")], &hdr(1, 1, "all drives"), None, false);
        assert!(out.contains("C:/x/y/\n  z.txt"), "{out}");
    }

    #[test]
    fn case_mismatched_root_stays_relative() {
        let out = render(&[file(r"C:\R\src\a.rs")], &hdr(1, 1, r"repo c:\r"), Some(Path::new(r"c:\r")), false);
        assert!(out.contains("src/\n  a.rs"), "{out}");
    }

    #[test]
    fn details_layout() {
        let e = [
            Entry { size: Some(4300), modified: Some(1_760_000_000), ..file(r"C:\r\src\api.ts") },
            Entry { modified: Some(1_760_000_000), ..dir(r"C:\r\src\lib") },
        ];
        let out = render(&e, &hdr(2, 2, r"repo C:\r"), Some(Path::new(r"C:\r")), true);
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines[1], "src/");
        assert!(lines[2].starts_with("  api.ts  4.2 KB  20"), "{out}");
        assert!(lines[3].starts_with("  lib/  20"), "{out}");
    }

    #[test]
    fn sizes() {
        assert_eq!(human_size(512), "512 B");
        assert_eq!(human_size(4300), "4.2 KB");
        assert_eq!(human_size(1_048_576), "1.0 MB");
        assert_eq!(human_size(3_758_096_384), "3.5 GB");
    }
}
