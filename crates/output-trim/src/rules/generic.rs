//! Fallback rule: head, error lines from the middle, and tail.

use super::{Outcome, Rule, Trimmed, error_lines, verdict};
use crate::collapse::{collapse_runs, dedupe_keep_order};

const HEAD: usize = 15;
const TAIL: usize = 30;

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
        let (body, tail) = if lines.len() <= HEAD + TAIL {
            (collapse_runs(lines, 3), Vec::new())
        } else {
            let mut kept: Vec<String> = lines[..HEAD].to_vec();
            kept.extend(error_lines(&lines[HEAD..lines.len() - TAIL], 2));
            (
                collapse_runs(&dedupe_keep_order(kept), 3),
                collapse_runs(&lines[lines.len() - TAIL..], 3),
            )
        };
        Trimmed {
            verdict: verdict("output", Outcome::Unknown, ""),
            body,
            tail,
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

    #[test]
    fn never_matches() {
        assert!(!Generic.matches_command("cargo test"));
        assert!(!Generic.matches_content(&["error".to_string()]));
    }
}
