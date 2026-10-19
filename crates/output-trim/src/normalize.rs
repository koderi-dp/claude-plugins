use regex::Regex;
use std::sync::LazyLock;

static ANSI: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07").unwrap());

/// Decode lossily, strip ANSI/progress noise, trim, and collapse blank runs.
pub fn normalize(bytes: &[u8]) -> Vec<String> {
    let text = String::from_utf8_lossy(bytes);
    let mut out: Vec<String> = Vec::new();
    for raw in text.split('\n') {
        // `\r\r\n` (and longer runs) end a line too; only an inner `\r` is a redraw.
        let line = raw.trim_end_matches('\r');
        let line = line.rsplit('\r').next().unwrap_or(line);
        let line = ANSI.replace_all(line, "");
        let line = line.trim_end();
        if line.is_empty() && out.last().is_none_or(|l| l.is_empty()) {
            continue;
        }
        out.push(line.to_string());
    }
    while out.last().is_some_and(|l| l.is_empty()) {
        out.pop();
    }
    out
}

/// Total characters including one newline per line.
pub fn char_len(lines: &[String]) -> usize {
    lines.iter().map(|l| l.chars().count() + 1).sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_ansi() {
        assert_eq!(normalize(b"\x1b[31merror\x1b[0m: x\n"), vec!["error: x"]);
    }

    #[test]
    fn keeps_text_after_last_cr() {
        assert_eq!(
            normalize(b"Progress 10%\rProgress 100%\nnext\n"),
            vec!["Progress 100%", "next"]
        );
    }

    #[test]
    fn crlf_is_newline() {
        assert_eq!(normalize(b"a\r\nb\r\n"), vec!["a", "b"]);
    }

    #[test]
    fn cr_cr_lf_keeps_line() {
        assert_eq!(
            normalize(b"Program.cs(3,1): error CS1002: ; expected\r\r\nnext\r\r\n"),
            vec!["Program.cs(3,1): error CS1002: ; expected", "next"]
        );
    }

    #[test]
    fn collapses_blank_runs() {
        assert_eq!(normalize(b"a\n\n\n\nb\n"), vec!["a", "", "b"]);
    }

    #[test]
    fn lossy_invalid_utf8() {
        let out = normalize(b"caf\xe9\n");
        assert_eq!(out.len(), 1);
        assert!(out[0].starts_with("caf"));
    }

    #[test]
    fn trims_trailing_blank_lines() {
        assert_eq!(normalize(b"a\n\n\n"), vec!["a"]);
    }

    #[test]
    fn char_len_counts_newlines() {
        assert_eq!(char_len(&["ab".into(), "c".into()]), 5);
    }
}
