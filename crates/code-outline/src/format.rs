use crate::extract::Symbol;

pub enum FileOutline {
    Symbols {
        display: String,
        line_count: usize,
        symbols: Vec<Symbol>,
        notes: Vec<String>,
    },
    Message(String),
}

const MAX_LINES: usize = 2000;

fn push_symbols(out: &mut Vec<String>, symbols: &[Symbol], depth: usize, signatures: bool) {
    for s in symbols {
        let text = if signatures && s.kind != "impl" && !s.signature.is_empty() {
            s.signature.clone()
        } else {
            s.label()
        };
        out.push(format!("{}{} {}-{}", "  ".repeat(depth), text, s.start_line, s.end_line));
        push_symbols(out, &s.children, depth + 1, signatures);
    }
}

fn render(file: &FileOutline, signatures: bool) -> Vec<String> {
    match file {
        FileOutline::Message(text) => text.lines().map(str::to_string).collect(),
        FileOutline::Symbols { display, line_count, symbols, notes } => {
            if symbols.is_empty() && notes.is_empty() {
                return vec![format!("{display} ({line_count} lines): no symbols found")];
            }
            let mut lines = vec![format!("{display} ({line_count} lines)")];
            push_symbols(&mut lines, symbols, 1, signatures);
            lines.extend(notes.iter().cloned());
            lines
        }
    }
}

/// Renders outlines, capping output at 2,000 lines. `total` is the number of
/// files matched before any `limit` was applied.
pub fn outline(files: &[FileOutline], total: usize, limit_hit: bool, signatures: bool) -> String {
    let mut body: Vec<String> = Vec::new();
    let mut shown = 0;
    let mut output_limited = false;
    for file in files {
        let lines = render(file, signatures);
        if shown == 0 {
            if lines.len() > MAX_LINES {
                body.extend(lines.into_iter().take(MAX_LINES));
                body.push("(outline truncated — narrow with read_symbol)".to_string());
                shown = 1;
                output_limited = files.len() > 1;
                break;
            }
        } else if body.len() + 1 + lines.len() > MAX_LINES {
            output_limited = true;
            break;
        } else {
            body.push(String::new());
        }
        body.extend(lines);
        shown += 1;
    }
    let header = if output_limited {
        Some(format!("showing {shown} of {total} files (output limit) — narrow paths"))
    } else if limit_hit {
        Some(format!("showing {shown} of {total} files (limit)"))
    } else {
        None
    };
    match header {
        Some(h) => format!("{h}\n{}", body.join("\n")),
        None => body.join("\n"),
    }
}

/// Lines `start..=end` (1-based) formatted like the Read tool.
pub fn numbered(source: &str, start: usize, end: usize) -> String {
    source
        .split('\n')
        .enumerate()
        .map(|(i, line)| (i + 1, line.strip_suffix('\r').unwrap_or(line)))
        .filter(|(n, _)| *n >= start && *n <= end)
        .map(|(n, line)| format!("{n:>6}\t{line}"))
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn human_size(bytes: u64) -> String {
    const KB: f64 = 1024.0;
    let b = bytes as f64;
    if bytes < 1024 {
        format!("{bytes} B")
    } else if b < KB * KB {
        format!("{:.1} KB", b / KB)
    } else {
        format!("{:.1} MB", b / (KB * KB))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sym(kind: &str, name: &str, s: usize, e: usize, sig: &str, children: Vec<Symbol>) -> Symbol {
        Symbol {
            kind: kind.into(),
            name: name.into(),
            key: name.into(),
            start_line: s,
            end_line: e,
            signature: sig.into(),
            children,
        }
    }

    fn file() -> FileOutline {
        FileOutline::Symbols {
            display: "src/server.rs".into(),
            line_count: 52,
            symbols: vec![
                sym("struct", "FindServer", 9, 12, "pub struct FindServer", vec![]),
                sym(
                    "impl",
                    "FindServer",
                    14,
                    30,
                    "impl FindServer",
                    vec![sym("fn", "new", 15, 17, "pub fn new() -> Self", vec![])],
                ),
            ],
            notes: vec![],
        }
    }

    fn many(display: &str, n: usize) -> FileOutline {
        FileOutline::Symbols {
            display: display.into(),
            line_count: n,
            symbols: (0..n).map(|i| sym("fn", &format!("f{i}"), i + 1, i + 1, "", vec![])).collect(),
            notes: vec![],
        }
    }

    #[test]
    fn nested_indent() {
        assert_eq!(
            outline(&[file()], 1, false, false),
            "src/server.rs (52 lines)\n  struct FindServer 9-12\n  impl FindServer 14-30\n    fn new 15-17"
        );
    }

    #[test]
    fn signatures_mode() {
        let out = outline(&[file()], 1, false, true);
        assert!(out.contains("    pub fn new() -> Self 15-17"));
        assert!(out.contains("  impl FindServer 14-30"));
    }

    #[test]
    fn empty_signature_falls_back_to_label() {
        let f = FileOutline::Symbols {
            display: "a.py".into(),
            line_count: 2,
            symbols: vec![sym("fn", "x", 1, 2, "", vec![])],
            notes: vec![],
        };
        assert_eq!(outline(&[f], 1, false, true), "a.py (2 lines)\n  fn x 1-2");
    }

    #[test]
    fn no_symbols() {
        let f = FileOutline::Symbols { display: "a.py".into(), line_count: 3, symbols: vec![], notes: vec![] };
        assert_eq!(outline(&[f], 1, false, false), "a.py (3 lines): no symbols found");
    }

    #[test]
    fn notes_after_symbols() {
        let f = FileOutline::Symbols {
            display: "a.rs".into(),
            line_count: 5,
            symbols: vec![sym("fn", "x", 1, 2, "", vec![])],
            notes: vec!["(syntax errors near lines 2 — outline may be incomplete)".into()],
        };
        let out = outline(&[f], 1, false, false);
        assert!(out.ends_with("(syntax errors near lines 2 — outline may be incomplete)"));
        assert!(out.contains("fn x 1-2\n(syntax"));
    }

    #[test]
    fn notes_without_symbols_have_no_empty_message() {
        let f = FileOutline::Symbols {
            display: "a.rs".into(),
            line_count: 5,
            symbols: vec![],
            notes: vec!["(note)".into()],
        };
        assert_eq!(outline(&[f], 1, false, false), "a.rs (5 lines)\n(note)");
    }

    #[test]
    fn message_renders_text() {
        let out = outline(&[FileOutline::Message("x not found.".into())], 1, false, false);
        assert_eq!(out, "x not found.");
    }

    #[test]
    fn blank_line_between_files() {
        let a = FileOutline::Symbols {
            display: "a.rs".into(),
            line_count: 12,
            symbols: vec![sym("fn", "a", 10, 12, "", vec![])],
            notes: vec![],
        };
        let b = FileOutline::Symbols { display: "b.rs".into(), line_count: 1, symbols: vec![], notes: vec![] };
        let out = outline(&[a, b], 2, false, false);
        assert!(out.contains("10-12\n\nb.rs ("));
    }

    #[test]
    fn limit_header() {
        let out = outline(&[file(), file()], 9, true, false);
        assert!(out.starts_with("showing 2 of 9 files (limit)\n"));
    }

    #[test]
    fn output_cap_at_file_boundary() {
        let files = [many("a.rs", 900), many("b.rs", 900), many("c.rs", 900)];
        let out = outline(&files, 3, false, false);
        assert!(out.starts_with("showing 2 of 3 files (output limit) — narrow paths\n"));
        assert!(!out.contains("c.rs"));
        assert!(out.contains("b.rs"));
    }

    #[test]
    fn output_cap_counts_separator_lines() {
        // each file is n + 1 lines; two files plus the blank separator
        let files = [many("a.rs", 999), many("b.rs", 999)];
        let out = outline(&files, 2, false, false);
        assert!(out.starts_with("showing 1 of 2 files (output limit) — narrow paths\n"));
        let files = [many("a.rs", 998), many("b.rs", 999)];
        let out = outline(&files, 2, false, false);
        assert!(out.contains("b.rs"));
        assert!(!out.contains("showing"));
    }

    #[test]
    fn single_huge_file_truncated() {
        let out = outline(&[many("a.rs", 2500)], 1, false, false);
        assert!(out.ends_with("(outline truncated — narrow with read_symbol)"));
        assert_eq!(out.lines().count(), 2001);
    }

    #[test]
    fn numbered_matches_read() {
        assert_eq!(numbered("a\r\nb\r\nc", 2, 3), "     2\tb\n     3\tc");
    }

    #[test]
    fn numbered_clamps_past_end() {
        assert_eq!(numbered("a\nb", 2, 9), "     2\tb");
    }

    #[test]
    fn sizes() {
        assert_eq!(human_size(3_565_158), "3.4 MB");
        assert_eq!(human_size(2048), "2.0 KB");
        assert_eq!(human_size(512), "512 B");
        assert_eq!(human_size(1024 * 1024), "1.0 MB");
    }
}
