//! Rule types, registry and shared helpers.

use crate::command::first_segment;
use regex::Regex;
use std::sync::LazyLock;

pub mod cargo;
pub mod docker_build;
pub mod docker_logs;
pub mod dotnet;
pub mod generic;
pub mod jstest;
pub mod node_install;
pub mod tsc;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Pass,
    Fail,
    Unknown,
}

/// A rule's result. `body` holds the details in priority order (errors, then
/// failed tests, then warnings); the engine's cap drops from its end. `tail`
/// holds summaries (and the last lines of a log) and is always kept.
pub struct Trimmed {
    pub verdict: String,
    pub body: Vec<String>,
    pub tail: Vec<String>,
    pub outcome: Outcome,
}

impl Trimmed {
    /// `body` followed by `tail`, uncapped.
    pub fn all_lines(&self) -> Vec<String> {
        self.body.iter().chain(&self.tail).cloned().collect()
    }
}

/// Warnings kept per code (CS8618, `unused_variables`, …) before the rest are counted.
pub const WARNINGS_PER_CODE: usize = 3;

/// `+K more <code> warnings`.
pub fn more_warnings(code: &str, k: usize) -> String {
    format!("+{k} more {code} warnings")
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
static JSTEST: jstest::JsTest = jstest::JsTest;
static NODE_INSTALL: node_install::NodeInstall = node_install::NodeInstall;
static DOCKER_BUILD: docker_build::DockerBuild = docker_build::DockerBuild;
static DOCKER_LOGS: docker_logs::DockerLogs = docker_logs::DockerLogs;
static GENERIC: generic::Generic = generic::Generic;

/// Rules in detection order; generic is always last. Later rules are inserted
/// on their own line before `&GENERIC` (and the array length bumped).
static REGISTRY: [&dyn Rule; 8] = [
    &DOTNET,
    &CARGO,
    &TSC,
    &JSTEST,
    &NODE_INSTALL,
    &DOCKER_BUILD,
    &DOCKER_LOGS,
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

/// Whether the line looks like an error or warning.
pub fn is_error_line(line: &str) -> bool {
    ERROR_RE.is_match(line)
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
    fn error_line_word_boundary() {
        assert!(is_error_line("ERROR db down"));
        assert!(is_error_line("thread main panicked"));
        assert!(!is_error_line("terrorist"));
        assert!(!is_error_line("errors"));
    }
}
