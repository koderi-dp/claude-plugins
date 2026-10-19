//! Rule types, registry and shared helpers.

use crate::collapse::dedupe_keep_order;
use crate::command::first_segment;
use regex::Regex;
use std::sync::LazyLock;

pub mod cargo;
pub mod dotnet;
pub mod generic;
pub mod tsc;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Pass,
    Fail,
    Unknown,
}

pub struct Trimmed {
    pub verdict: String,
    pub body: Vec<String>,
    pub outcome: Outcome,
}

pub trait Rule: Sync {
    fn name(&self) -> &'static str;
    fn matches_command(&self, first_segment: &str) -> bool;
    fn matches_content(&self, lines: &[String]) -> bool;
    fn trim(&self, lines: &[String]) -> Trimmed;
}

static DOTNET: dotnet::Dotnet = dotnet::Dotnet;
static CARGO: cargo::Cargo = cargo::Cargo;
static TSC: tsc::Tsc = tsc::Tsc;
static GENERIC: generic::Generic = generic::Generic;

/// Rules in detection order; generic is always last. Later rules are inserted
/// on their own line before `&GENERIC` (and the array length bumped).
static REGISTRY: [&dyn Rule; 4] = [
    &DOTNET,
    &CARGO,
    &TSC,
    &GENERIC,
];

pub fn registry() -> &'static [&'static dyn Rule] {
    &REGISTRY
}

/// The specific rule claiming this command line; never the generic rule.
pub fn by_command(cmd: &str) -> Option<&'static dyn Rule> {
    let seg = first_segment(cmd);
    registry()
        .iter()
        .copied()
        .find(|r| r.name() != GENERIC.name() && r.matches_command(seg))
}

/// First rule in registry order whose content signature matches, else generic.
pub fn by_content(lines: &[String]) -> &'static dyn Rule {
    registry()
        .iter()
        .copied()
        .find(|r| r.matches_content(lines))
        .unwrap_or(&GENERIC)
}

/// `[output-trim] {label}: {PASSED|FAILED|DONE} — {detail}` (detail optional).
pub fn verdict(label: &str, outcome: Outcome, detail: &str) -> String {
    let word = match outcome {
        Outcome::Pass => "PASSED",
        Outcome::Fail => "FAILED",
        Outcome::Unknown => "DONE",
    };
    if detail.is_empty() {
        format!("[output-trim] {label}: {word}")
    } else {
        format!("[output-trim] {label}: {word} — {detail}")
    }
}

static ERROR_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(error|warn(ing)?|fail(ed|ure)?|panic(ked)?|exception)\b").unwrap()
});

/// Lines that look like errors or warnings, each followed by `context` more
/// lines, in original order without duplicates.
pub fn error_lines(lines: &[String], context: usize) -> Vec<String> {
    let mut keep = Vec::new();
    let mut next = 0; // first index not yet emitted
    for (i, line) in lines.iter().enumerate() {
        if ERROR_RE.is_match(line) {
            let end = (i + context + 1).min(lines.len());
            keep.extend(lines[next.max(i)..end].iter().cloned());
            next = next.max(end);
        }
    }
    dedupe_keep_order(keep)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn by_content_falls_back_to_generic() {
        assert_eq!(by_content(&s(&["hello", "world"])).name(), "generic");
    }

    #[test]
    fn by_command_never_returns_generic() {
        assert!(by_command("git status").is_none());
        assert!(by_command("cd x && git status | tail").is_none());
    }

    #[test]
    fn verdict_formats() {
        assert_eq!(
            verdict("cargo test", Outcome::Fail, "2 failed"),
            "[output-trim] cargo test: FAILED — 2 failed"
        );
        assert_eq!(
            verdict("output", Outcome::Unknown, ""),
            "[output-trim] output: DONE"
        );
        assert_eq!(
            verdict("x", Outcome::Pass, "ok"),
            "[output-trim] x: PASSED — ok"
        );
    }

    #[test]
    fn error_lines_keeps_context_after() {
        let lines = s(&["a", "error: boom", "c1", "c2", "c3", "d"]);
        assert_eq!(error_lines(&lines, 2), s(&["error: boom", "c1", "c2"]));
    }

    #[test]
    fn error_lines_dedupes_and_handles_overlap() {
        let lines = s(&["error: x", "warning: y", "z", "error: x"]);
        assert_eq!(error_lines(&lines, 1), s(&["error: x", "warning: y", "z"]));
    }

    #[test]
    fn error_lines_word_boundary() {
        assert!(error_lines(&s(&["terrorist", "errors"]), 0).is_empty());
    }
}
