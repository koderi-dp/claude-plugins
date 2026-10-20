//! Trimming engine: pass-through, rule dispatch, body cap and footer.

use crate::rules::generic::Generic;
use crate::rules::{Outcome, Rule, Trimmed};
use crate::store;
use std::panic::{self, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const BODY_CAP: usize = 6_000;
pub const FILTER_PASSTHROUGH: usize = 1_500;
/// Longest single line kept whole; longer ones are cut to this and `…`.
pub const LINE_CAP: usize = 500;

pub enum LogTarget<'a> {
    SaveIn(&'a Path),
    Existing(&'a Path),
}

pub struct Output {
    pub text: String,
    pub outcome: Outcome,
    pub kept_chars: usize,
    pub total_chars: usize,
    pub trimmed: bool,
    /// The full log the footer points to; `None` when nothing was trimmed or
    /// saving it failed.
    pub log_path: Option<PathBuf>,
}

/// Serialises swapping of the process-wide panic hook.
static HOOK_LOCK: Mutex<()> = Mutex::new(());

/// Runs the rule; a panicking rule falls back to the generic rule. The default
/// panic message is suppressed while the rule runs so stderr stays clean.
fn trim_safely(rule: &dyn Rule, lines: &[String]) -> Trimmed {
    let _guard = HOOK_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let previous = panic::take_hook();
    panic::set_hook(Box::new(|_| {}));
    let result = panic::catch_unwind(AssertUnwindSafe(|| rule.trim(lines)));
    panic::set_hook(previous);
    result.unwrap_or_else(|_| Generic.trim(lines))
}

/// The line, or its first `LINE_CAP` characters plus `…` when longer.
fn cut_line(line: &str) -> String {
    match line.char_indices().nth(LINE_CAP) {
        Some((at, _)) => format!("{}…", &line[..at]),
        None => line.to_string(),
    }
}

fn width(line: &str) -> usize {
    line.chars().count() + 1
}

/// Fits body and tail (each line cut by `cut_line`) into `BODY_CAP`. The tail
/// is kept whole and the rest of the budget goes to the start of the body; a
/// tail over the budget keeps its last lines. `… +N more lines` stands between
/// the two when anything was dropped.
fn cap(body: &[String], tail: &[String]) -> Vec<String> {
    let tail: Vec<String> = tail.iter().map(|l| cut_line(l)).collect();
    let mut skip_tail = 0;
    let mut tail_used: usize = tail.iter().map(|l| width(l)).sum();
    while tail_used > BODY_CAP {
        tail_used -= width(&tail[skip_tail]);
        skip_tail += 1;
    }

    let mut out = Vec::new();
    let mut used = tail_used;
    let mut dropped = skip_tail;
    for (i, line) in body.iter().enumerate() {
        let line = cut_line(line);
        if used + width(&line) > BODY_CAP {
            dropped += body.len() - i;
            break;
        }
        used += width(&line);
        out.push(line);
    }
    if dropped > 0 {
        out.push(format!("… +{dropped} more lines"));
    }
    out.extend(tail.into_iter().skip(skip_tail));
    out
}

pub fn apply(lines: &[String], rule: &dyn Rule, log: LogTarget, input_truncated: bool) -> Output {
    if lines.is_empty() {
        return Output {
            text: String::new(),
            outcome: Outcome::Unknown,
            kept_chars: 0,
            total_chars: 0,
            trimmed: false,
            log_path: None,
        };
    }
    let full = lines.join("\n");
    let total_chars = full.chars().count();

    if total_chars < FILTER_PASSTHROUGH {
        let (text, outcome) = if rule.name() == Generic.name() {
            (full, Outcome::Unknown)
        } else {
            let t = trim_safely(rule, lines);
            (format!("{}\n{full}", t.verdict), t.outcome)
        };
        return Output {
            kept_chars: text.chars().count(),
            text,
            outcome,
            total_chars,
            trimmed: false,
            log_path: None,
        };
    }

    let t = trim_safely(rule, lines);
    let mut out = Vec::with_capacity(t.body.len() + t.tail.len() + 2);
    out.push(t.verdict);
    out.extend(cap(&t.body, &t.tail));

    let log_path = match log {
        LogTarget::SaveIn(dir) => store::save(dir, &full).ok(),
        LogTarget::Existing(p) => Some(p.to_path_buf()),
    };
    let location = match &log_path {
        Some(p) => format!("full: {}", p.display()),
        None => "full log unavailable".to_string(),
    };
    let note = if input_truncated {
        " · input truncated at 64 MB"
    } else {
        ""
    };
    // Footer's own length is tiny; kept count is computed on the final text.
    let footer = |kept: usize| {
        format!(
            "[output-trim] kept {} of {} chars · {location}{note}",
            fmt_k(kept),
            fmt_k(total_chars)
        )
    };
    let head = out.join("\n");
    let mut text = format!("{head}\n{}", footer(0));
    let kept = text.chars().count();
    text = format!("{head}\n{}", footer(kept));
    Output {
        kept_chars: text.chars().count(),
        text,
        outcome: t.outcome,
        total_chars,
        trimmed: true,
        log_path,
    }
}

/// `n/1000` with one decimal, trailing `.0` removed, plus `k`; from one
/// million (after rounding) `n/1000000` plus `M`.
pub fn fmt_k(n: usize) -> String {
    let (tenths, unit) = match (n + 50) / 100 {
        t if t < 10_000 => (t, 'k'),
        _ => ((n + 50_000) / 100_000, 'M'),
    };
    if tenths.is_multiple_of(10) {
        format!("{}{unit}", tenths / 10)
    } else {
        format!("{}.{}{unit}", tenths / 10, tenths % 10)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixed {
        name: &'static str,
        body: Vec<String>,
        tail: Vec<String>,
        panics: bool,
    }

    impl Rule for Fixed {
        fn name(&self) -> &'static str {
            self.name
        }
        fn matches_command(&self, _: &str) -> bool {
            false
        }
        fn matches_content(&self, _: &[String]) -> bool {
            false
        }
        fn trim(&self, _: &[String]) -> Trimmed {
            if self.panics {
                panic!("boom");
            }
            Trimmed {
                verdict: "[output-trim] fixed: DONE".to_string(),
                body: self.body.clone(),
                tail: self.tail.clone(),
                outcome: Outcome::Fail,
            }
        }
    }

    fn fixed(body: Vec<String>) -> Fixed {
        Fixed {
            name: "fixed",
            body,
            tail: vec![],
            panics: false,
        }
    }

    fn big(n: usize) -> Vec<String> {
        (0..n)
            .map(|i| format!("line {i:05} {}", "x".repeat(80)))
            .collect()
    }

    fn files(dir: &Path) -> usize {
        std::fs::read_dir(dir).map(|d| d.count()).unwrap_or(0)
    }

    #[test]
    fn fmt_k_cases() {
        assert_eq!(fmt_k(300), "0.3k");
        assert_eq!(fmt_k(50_000), "50k");
        assert_eq!(fmt_k(48_700), "48.7k");
        assert_eq!(fmt_k(999_900), "999.9k");
    }

    #[test]
    fn fmt_k_millions() {
        assert_eq!(fmt_k(55_402_297), "55.4M");
        assert_eq!(fmt_k(1_000_000), "1M");
        assert_eq!(fmt_k(999_950), "1M");
    }

    #[test]
    fn empty_input_passes_through() {
        let d = tempfile::tempdir().unwrap();
        let o = apply(&[], &fixed(vec![]), LogTarget::SaveIn(d.path()), false);
        assert_eq!(o.text, "");
        assert!(!o.trimmed);
        assert_eq!(o.outcome, Outcome::Unknown);
        assert_eq!(files(d.path()), 0);
    }

    #[test]
    fn small_input_passes_through() {
        let d = tempfile::tempdir().unwrap();
        let lines: Vec<String> = (0..10).map(|i| format!("l{i}")).collect();
        let o = apply(
            &lines,
            &Fixed {
                name: "generic",
                body: vec![],
                tail: vec![],
                panics: true,
            },
            LogTarget::SaveIn(d.path()),
            false,
        );
        assert_eq!(o.text, lines.join("\n"));
        assert!(!o.trimmed);
        assert_eq!(files(d.path()), 0);
    }

    #[test]
    fn small_input_gets_verdict_for_specific_rule() {
        let d = tempfile::tempdir().unwrap();
        let lines = vec!["a".to_string(), "b".to_string()];
        let o = apply(&lines, &fixed(vec![]), LogTarget::SaveIn(d.path()), false);
        assert_eq!(o.text, "[output-trim] fixed: DONE\na\nb");
        assert!(!o.trimmed);
        assert_eq!(o.outcome, Outcome::Fail);
    }

    #[test]
    fn footer_with_saved_path() {
        let d = tempfile::tempdir().unwrap();
        let lines = big(30); // > 1,500 chars
        let o = apply(
            &lines,
            &fixed(vec!["kept".into()]),
            LogTarget::SaveIn(d.path()),
            false,
        );
        assert!(o.trimmed);
        let last = o.text.lines().last().unwrap();
        let path = last.split("· full: ").nth(1).expect("footer path");
        assert!(last.starts_with("[output-trim] kept "));
        assert!(Path::new(path).exists());
        assert_eq!(o.log_path.as_deref(), Some(Path::new(path)));
        assert_eq!(std::fs::read_to_string(path).unwrap(), lines.join("\n"));
        assert_eq!(o.total_chars, lines.join("\n").chars().count());
        assert_eq!(o.kept_chars, o.text.chars().count());
    }

    #[test]
    fn footer_existing_path() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("persisted.txt");
        std::fs::write(&p, "x").unwrap();
        let o = apply(
            &big(30),
            &fixed(vec!["kept".into()]),
            LogTarget::Existing(&p),
            false,
        );
        assert!(o.text.ends_with(&format!("· full: {}", p.display())));
        assert_eq!(o.log_path.as_deref(), Some(p.as_path()));
        assert_eq!(files(d.path()), 1);
    }

    #[test]
    fn unavailable_log_footer() {
        let d = tempfile::tempdir().unwrap();
        let blocker = d.path().join("file");
        std::fs::write(&blocker, "x").unwrap();
        let o = apply(
            &big(30),
            &fixed(vec!["kept".into()]),
            LogTarget::SaveIn(&blocker.join("sub")),
            false,
        );
        assert!(o.text.ends_with("· full log unavailable"));
        assert!(o.trimmed);
        assert!(o.log_path.is_none());
    }

    #[test]
    fn cap_by_lines() {
        let d = tempfile::tempdir().unwrap();
        let body: Vec<String> = (0..1000).map(|_| "y".repeat(100)).collect();
        let o = apply(&big(30), &fixed(body), LogTarget::SaveIn(d.path()), false);
        // 100 chars + newline each: 59 fit in 6,000.
        let lines: Vec<&str> = o.text.lines().collect();
        let kept = lines.iter().filter(|l| **l == "y".repeat(100)).count();
        assert_eq!(kept, 59);
        assert!(lines.iter().any(|l| *l == "… +941 more lines"));
    }

    #[test]
    fn cap_single_huge_line() {
        let d = tempfile::tempdir().unwrap();
        let huge = "z".repeat(5_000_000);
        let lines = vec![huge.clone()];
        let o = apply(
            &lines,
            &fixed(vec![huge]),
            LogTarget::SaveIn(d.path()),
            false,
        );
        assert!(o.text.chars().count() < 7_000);
        assert!(o.text.contains('…'));
        assert!(o.trimmed);
        assert!(!o.text.contains("more lines"));
    }

    #[test]
    fn overlong_second_line_is_cut_and_later_lines_kept() {
        let d = tempfile::tempdir().unwrap();
        let mut body = vec!["first".to_string(), "q".repeat(7_000)];
        body.extend((1..=5).map(|i| format!("failure {i}")));
        let o = apply(&big(30), &fixed(body), LogTarget::SaveIn(d.path()), false);
        for i in 1..=5 {
            assert!(o.text.contains(&format!("failure {i}")), "{}", o.text);
        }
        let cut = format!("{}…", "q".repeat(LINE_CAP));
        assert!(o.text.lines().any(|l| l == cut), "{}", o.text);
        assert!(!o.text.contains("more lines"), "{}", o.text);
    }

    #[test]
    fn tail_is_kept_after_a_long_body() {
        let d = tempfile::tempdir().unwrap();
        let body: Vec<String> = (0..1000).map(|_| "y".repeat(100)).collect();
        let rule = Fixed {
            tail: vec!["test result: FAILED".into()],
            ..fixed(body)
        };
        let o = apply(&big(30), &rule, LogTarget::SaveIn(d.path()), false);
        let lines: Vec<&str> = o.text.lines().collect();
        let n = lines.len();
        assert_eq!(lines[n - 2], "test result: FAILED", "{}", o.text);
        // 6,000 - 20 for the tail leaves room for 59 body lines of 101.
        assert_eq!(lines[n - 3], "… +941 more lines");
        assert_eq!(lines.iter().filter(|l| **l == "y".repeat(100)).count(), 59);
    }

    #[test]
    fn oversized_tail_keeps_its_last_lines() {
        let d = tempfile::tempdir().unwrap();
        let tail: Vec<String> = (0..100)
            .map(|i| format!("{i:03}{}", "t".repeat(97)))
            .collect();
        let rule = Fixed {
            tail,
            ..fixed(vec!["b".repeat(100); 5])
        };
        let o = apply(&big(30), &rule, LogTarget::SaveIn(d.path()), false);
        assert!(o.text.contains("… +46 more lines"), "{}", o.text);
        assert!(!o.text.contains(&"b".repeat(100)), "{}", o.text);
        assert!(!o.text.contains("040t"), "{}", o.text);
        assert!(o.text.contains("041t"), "{}", o.text);
        assert!(o.text.contains("099t"), "{}", o.text);
    }

    #[test]
    fn truncated_note() {
        let d = tempfile::tempdir().unwrap();
        let o = apply(
            &big(30),
            &fixed(vec!["k".into()]),
            LogTarget::SaveIn(d.path()),
            true,
        );
        assert!(o.text.ends_with("· input truncated at 64 MB"));
        assert!(o.text.contains("· full: "));
    }

    #[test]
    fn panicking_rule_falls_back() {
        let d = tempfile::tempdir().unwrap();
        let o = apply(
            &big(30),
            &Fixed {
                name: "bad",
                body: vec![],
                tail: vec![],
                panics: true,
            },
            LogTarget::SaveIn(d.path()),
            false,
        );
        assert!(o.trimmed);
        assert!(o.text.starts_with("[output-trim] "));
        assert!(!o.text.starts_with("[output-trim] fixed"));
    }
}
