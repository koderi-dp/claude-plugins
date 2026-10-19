//! Trimming engine: pass-through, rule dispatch, body cap and footer.

use crate::rules::generic::Generic;
use crate::rules::{Outcome, Rule, Trimmed};
use crate::store;
use std::panic::{self, AssertUnwindSafe};
use std::path::Path;
use std::sync::Mutex;

pub const BODY_CAP: usize = 6_000;
pub const FILTER_PASSTHROUGH: usize = 1_500;

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

/// Whole lines while they fit in `BODY_CAP`; if not even the first fits it is
/// cut to the budget with `…`. Appends `… +N more lines` for dropped lines.
fn cap_body(body: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    let mut used = 0;
    for (i, line) in body.iter().enumerate() {
        let len = line.chars().count() + 1;
        if used + len <= BODY_CAP {
            out.push(line.clone());
            used += len;
            continue;
        }
        let mut dropped = body.len() - i;
        if out.is_empty() {
            let cut: String = line.chars().take(BODY_CAP - 2).collect();
            out.push(format!("{cut}…"));
            dropped -= 1;
        }
        if dropped > 0 {
            out.push(format!("… +{dropped} more lines"));
        }
        break;
    }
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
        };
    }

    let t = trim_safely(rule, lines);
    let mut out = Vec::with_capacity(t.body.len() + 2);
    out.push(t.verdict);
    out.extend(cap_body(&t.body));

    let location = match log {
        LogTarget::SaveIn(dir) => match store::save(dir, &full) {
            Ok(p) => format!("full: {}", p.display()),
            Err(_) => "full log unavailable".to_string(),
        },
        LogTarget::Existing(p) => format!("full: {}", p.display()),
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
    }
}

/// `n/1000` with one decimal, trailing `.0` removed, plus `k`.
pub fn fmt_k(n: usize) -> String {
    let tenths = (n + 50) / 100;
    if tenths.is_multiple_of(10) {
        format!("{}k", tenths / 10)
    } else {
        format!("{}.{}k", tenths / 10, tenths % 10)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixed {
        name: &'static str,
        body: Vec<String>,
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
                outcome: Outcome::Fail,
            }
        }
    }

    fn fixed(body: Vec<String>) -> Fixed {
        Fixed {
            name: "fixed",
            body,
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
