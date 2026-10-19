//! Compact grouped text output. Knows nothing about Everything or git.

use crate::filter::strip_root_ci;
use crate::pipeline::Entry;
use std::path::{Path, PathBuf};

pub struct Header {
    pub count: u32,
    pub count_is_upper_bound: bool,
    /// Visible results skipped before the first one shown (the `offset` param).
    pub first: usize,
    pub shown: usize,
    /// `repo C:\Source\app`, `C:\some\path` or `all drives`.
    pub scope_label: String,
    pub page_capped: bool,
    pub hidden_by_ignore: u32,
    pub indexing: bool,
}

/// Header only, for `count_only`.
pub fn render_count(header: &Header) -> String {
    let mut out = indexing_line(header);
    out.push_str(&format!(
        "{}{} {} — {}{}",
        bound(header),
        header.count,
        noun(header.count),
        header.scope_label,
        notes(header)
    ));
    out
}

/// One full path per line, for `flat`.
pub fn render_flat(entries: &[Entry], header: &Header, details: bool) -> String {
    let mut out = indexing_line(header);
    out.push_str(&header_line(header));
    out.push('\n');
    for e in entries {
        let mut line = e.full_path.display().to_string();
        if e.is_dir {
            line.push('\\');
        }
        if details {
            line.push_str(&detail_suffix(e));
        }
        out.push_str(&line);
        out.push('\n');
    }
    out
}

pub fn render(entries: &[Entry], header: &Header, root: Option<&Path>, details: bool) -> String {
    let mut out = indexing_line(header);
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
                out.push_str(&format!("  {}{}\n", display_name(e), detail_suffix(e)));
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

fn indexing_line(h: &Header) -> String {
    if h.indexing { "Everything is still indexing; results may be incomplete.\n".to_string() } else { String::new() }
}

fn bound(h: &Header) -> &'static str {
    if h.count_is_upper_bound { "≤" } else { "" }
}

pub fn noun(count: u32) -> &'static str {
    if count == 1 { "match" } else { "matches" }
}

fn notes(h: &Header) -> String {
    let mut notes = String::new();
    if h.page_capped {
        notes.push_str(" (scan capped at 10 pages)");
    }
    if h.hidden_by_ignore > 0 {
        notes.push_str(&format!(" ({} hidden by .gitignore — retry with include_ignored: true)", h.hidden_by_ignore));
    }
    notes
}

fn header_line(h: &Header) -> String {
    let end = h.first + h.shown;
    let limit = if (end as u64) < h.count as u64 { " (limit)" } else { "" };
    let showing = if h.first == 0 { h.shown.to_string() } else { format!("{}–{end}", h.first + 1) };
    format!("{}{} {}, showing {showing}{limit} — {}{}", bound(h), h.count, noun(h.count), h.scope_label, notes(h))
}

fn detail_suffix(e: &Entry) -> String {
    let mut s = String::new();
    if let Some(size) = e.size.filter(|_| !e.is_dir) {
        s.push_str(&format!("  {}", human_size(size)));
    }
    if let Some(ts) = e.modified.and_then(local_time) {
        s.push_str(&format!("  {ts}"));
    }
    s
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
            count_is_upper_bound: false,
            first: 0,
            shown,
            scope_label: label.to_string(),
            page_capped: false,
            hidden_by_ignore: 0,
            indexing: false,
        }
    }

    #[test]
    fn singular_match() {
        let out = render(&[file(r"C:\r\a.rs")], &hdr(1, 1, r"repo C:\r"), Some(Path::new(r"C:\r")), false);
        assert!(out.starts_with("1 match, showing 1 — repo C:\\r\n"), "{out}");
    }

    #[test]
    fn offset_shows_range() {
        let h = Header { first: 50, ..hdr(120, 50, "all drives") };
        let out = render(&[file(r"C:\x\a")], &h, None, false);
        assert!(out.starts_with("120 matches, showing 51–100 (limit) — all drives\n"), "{out}");
    }

    #[test]
    fn offset_last_page_has_no_limit_marker() {
        let h = Header { first: 100, ..hdr(120, 20, "all drives") };
        let out = render(&[file(r"C:\x\a")], &h, None, false);
        assert!(out.starts_with("120 matches, showing 101–120 — all drives\n"), "{out}");
    }

    #[test]
    fn count_only_header() {
        let h = Header { count_is_upper_bound: true, hidden_by_ignore: 2, ..hdr(7, 0, r"repo C:\r") };
        assert_eq!(
            render_count(&h),
            "≤7 matches — repo C:\\r (2 hidden by .gitignore — retry with include_ignored: true)"
        );
        assert_eq!(render_count(&hdr(1, 0, "all drives")), "1 match — all drives");
    }

    #[test]
    fn flat_full_paths() {
        let e = [
            Entry { size: Some(4300), ..file(r"C:\r\src\a.rs") },
            dir(r"C:\r\src\lib"),
        ];
        assert_eq!(
            render_flat(&e, &hdr(2, 2, r"repo C:\r"), false),
            "2 matches, showing 2 — repo C:\\r\nC:\\r\\src\\a.rs\nC:\\r\\src\\lib\\\n"
        );
        let detailed = render_flat(&e, &hdr(2, 2, r"repo C:\r"), true);
        assert!(detailed.contains("C:\\r\\src\\a.rs  4.2 KB\n"), "{detailed}");
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
        let h = Header { count: 40, count_is_upper_bound: true, shown: 20, hidden_by_ignore: 3, ..hdr(0, 0, r"repo C:\r") };
        assert!(render(&e, &h, Some(Path::new(r"C:\r")), false).starts_with(
            "≤40 matches, showing 20 (limit) — repo C:\\r (3 hidden by .gitignore — retry with include_ignored: true)\n"
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
        assert!(out.starts_with("Everything is still indexing; results may be incomplete.\n1 match,"));
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
