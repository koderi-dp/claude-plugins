//! Fallback rule: repeated lines collapsed, then the first entries, error
//! lines (with context) and collapsed runs from the middle, and the last entries.

use super::{Outcome, Rule, Trimmed, is_error_line, verdict};
use crate::collapse::collapse_runs_counted;
use std::collections::HashSet;

/// Entries kept from the start (body) and the end (tail).
const HEAD: usize = 15;
const TAIL: usize = 30;
/// Entries kept after each error line in the middle.
const CONTEXT: usize = 2;
/// Minimum run length that is collapsed into `(×N similar) …`.
const MIN_RUN: usize = 3;

pub struct Generic;

impl Rule for Generic {
    fn name(&self) -> &'static str {
        "generic"
    }

    fn matches_command(&self, _first_segment: &str) -> bool {
        false
    }

    fn matches_content(&self, _lines: &[String]) -> bool {
        false
    }

    fn trim(&self, lines: &[String]) -> Trimmed {
        let entries = collapse_runs_counted(lines, MIN_RUN);
        let n = entries.len();
        let head_end = HEAD.min(n);
        let tail_start = n.saturating_sub(TAIL).max(head_end);

        let mut seen: HashSet<&str> = entries[..head_end].iter().map(|e| e.0.as_str()).collect();
        let mut body: Vec<String> = entries[..head_end].iter().map(|e| e.0.clone()).collect();
        // Middle: error lines with context and collapsed runs; the rest is
        // counted (in input lines) into `… N lines omitted`.
        let mut context_until = head_end;
        let mut omitted = 0usize;
        for (i, (text, count)) in entries.iter().enumerate().take(tail_start).skip(head_end) {
            let error = is_error_line(text);
            if error {
                context_until = i + CONTEXT + 1;
            }
            let wanted = error || i < context_until || *count > 1;
            // Repeats of a line already shown are counted, not kept again.
            if wanted && (*count > 1 || seen.insert(text)) {
                if omitted > 0 {
                    body.push(format!("… {omitted} lines omitted"));
                    omitted = 0;
                }
                body.push(text.clone());
            } else {
                omitted += count;
            }
        }
        if omitted > 0 {
            body.push(format!("… {omitted} lines omitted"));
        }

        Trimmed {
            verdict: verdict("output", Outcome::Unknown, ""),
            body,
            tail: entries[tail_start..].iter().map(|e| e.0.clone()).collect(),
            outcome: Outcome::Unknown,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Unique, template-distinct line text for index `i` (letters only, so
    /// `collapse_runs` does not merge neighbours).
    fn name(i: usize) -> String {
        let a = (b'a' + (i / 26 / 26 % 26) as u8) as char;
        let b = (b'a' + (i / 26 % 26) as u8) as char;
        let c = (b'a' + (i % 26) as u8) as char;
        format!("{a}{b}{c} entry")
    }

    #[test]
    fn keeps_head_errors_and_tail() {
        let mut lines: Vec<String> = (1..=200).map(name).collect();
        lines[99] = "ERROR db down".to_string();
        let t = Generic.trim(&lines);
        let has = |l: &str| t.all_lines().iter().any(|b| b == l);
        assert!(has(&name(1)));
        assert!(has(&name(15)));
        assert!(has("ERROR db down"));
        assert!(has(&name(101)));
        assert!(has(&name(102)));
        assert!(has(&name(200)));
        assert!(!has(&name(50)));
        let mut sorted = t.all_lines();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), t.all_lines().len());
        assert_eq!(t.verdict, "[output-trim] output: DONE");
        assert_eq!(t.outcome, Outcome::Unknown);
    }

    #[test]
    fn short_input_kept_whole() {
        let lines: Vec<String> = (1..=10).map(name).collect();
        assert_eq!(Generic.trim(&lines).all_lines(), lines);
    }

    /// Input lines each output line stands for: `(×N similar)` is N,
    /// `… N lines omitted` is N, anything else is 1.
    fn represented(out: &[String]) -> usize {
        out.iter()
            .map(|l| {
                if let Some(r) = l.strip_prefix("(×") {
                    r.split(' ').next().unwrap().parse().unwrap()
                } else if let Some(r) = l.strip_prefix("… ") {
                    r.strip_suffix(" lines omitted").unwrap().parse().unwrap()
                } else {
                    1
                }
            })
            .sum()
    }

    #[test]
    fn identical_template_run_is_counted_whole() {
        let lines: Vec<String> = (0..1500)
            .map(|i| format!("request {i} handled ok"))
            .collect();
        let out = Generic.trim(&lines).all_lines();
        assert_eq!(out, vec!["(×1500 similar) request 0 handled ok"]);
    }

    #[test]
    fn distinct_lines_report_what_was_omitted() {
        let lines: Vec<String> = (0..1000).map(name).collect();
        let t = Generic.trim(&lines);
        let out = t.all_lines();
        assert!(out.contains(&"… 955 lines omitted".to_string()), "{out:#?}");
        assert_eq!(t.tail.len(), 30);
        assert_eq!(represented(&out), 1000);
    }

    #[test]
    fn error_between_collapsed_runs_survives() {
        let mut lines: Vec<String> = (0..20).map(name).collect();
        lines.extend((0..100).map(|i| format!("poll {i} idle")));
        lines.extend((100..120).map(name));
        lines.push("ERROR db down".to_string());
        lines.extend((200..220).map(name));
        lines.extend((0..100).map(|i| format!("tick {i} queued")));
        lines.extend((300..340).map(name));
        let out = Generic.trim(&lines).all_lines();
        assert!(
            out.contains(&"(×100 similar) poll 0 idle".to_string()),
            "{out:#?}"
        );
        assert!(out.contains(&"ERROR db down".to_string()), "{out:#?}");
        assert!(
            out.contains(&"(×100 similar) tick 0 queued".to_string()),
            "{out:#?}"
        );
        assert_eq!(represented(&out), lines.len());
    }

    #[test]
    fn error_in_middle_keeps_two_lines_of_context() {
        let mut lines: Vec<String> = (0..200).map(name).collect();
        lines[99] = "error: boom".to_string();
        let out = Generic.trim(&lines).all_lines();
        let at = out
            .iter()
            .position(|l| l == "error: boom")
            .expect("error kept");
        assert_eq!(out[at + 1], name(100));
        assert_eq!(out[at + 2], name(101));
        assert_eq!(out[at + 3], "… 68 lines omitted");
        assert_eq!(out[at - 1], "… 84 lines omitted");
        assert_eq!(represented(&out), 200);
    }

    #[test]
    fn repeated_error_line_is_shown_once() {
        let mut lines: Vec<String> = (0..200).map(name).collect();
        for i in [40, 80, 120] {
            lines[i] = "WARN disk almost full".to_string();
        }
        let out = Generic.trim(&lines).all_lines();
        assert_eq!(
            out.iter().filter(|l| *l == "WARN disk almost full").count(),
            1
        );
        assert_eq!(represented(&out), 200);
    }

    #[test]
    fn never_matches() {
        assert!(!Generic.matches_command("cargo test"));
        assert!(!Generic.matches_content(&["error".to_string()]));
    }
}
