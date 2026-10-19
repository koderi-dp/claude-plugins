//! `dotnet build` / `dotnet test`: diagnostics, failed tests and summaries.

use super::{Outcome, Rule, Trimmed, WARNINGS_PER_CODE, more_warnings, verdict};
use crate::collapse::dedupe_keep_order;
use regex::Regex;
use std::sync::LazyLock;

pub struct Dotnet;

static DIAG_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"^(?:\s*\d+>)?\s*(?P<file>.+?)\((?P<line>\d+),(?P<col>\d+)\): (?P<sev>error|warning) (?P<code>[A-Z]+\d+): (?P<msg>.+?)(?: \[(?P<proj>.+)\])?$",
    )
    .unwrap()
});
static SUMMARY_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(Passed|Failed)!\s+- Failed:\s*(\d+), Passed:\s*(\d+), Skipped:\s*(\d+)").unwrap()
});
static FAILED_TEST_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*Failed \S.*\[[^\]]*\]\s*$").unwrap());
static COUNT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*(\d+) (Warning|Error)\(s\)\s*$").unwrap());
static ERROR_WORD_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\berror\b").unwrap());
/// Failure lines without the word `error`; narrow on purpose (verbose builds are noisy).
static FAILURE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)test run (failed|aborted)|\baborted\b|\bcrashed\b|unhandled exception|failed to restore|^\s*Failed [\w+.`<>]+(\(.*\))?\s*$",
    )
    .unwrap()
});

fn is_gate(line: &str) -> bool {
    ERROR_WORD_RE.is_match(line) || FAILURE_RE.is_match(line)
}
static SIGNATURE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^\s*(?:(?:\d+>)?\s*Build (?:succeeded|FAILED)\.|.*\berror (?:CS|NU|MSB)\d+)")
        .unwrap()
});

const NOISE_FRAMES: [&str; 5] = [
    "at System.",
    "at Microsoft.",
    "at Xunit.",
    "at NUnit.",
    "at Castle.",
];

#[derive(PartialEq)]
enum Section {
    None,
    Message,
    Stack,
    Other,
}

fn project_name(proj: &str) -> &str {
    proj.rsplit(['\\', '/']).next().unwrap_or(proj)
}

/// Codes in first-seen order, each with its lines.
fn push_grouped(groups: &mut Vec<(String, Vec<String>)>, code: &str, line: String) {
    match groups.iter_mut().find(|(c, _)| c == code) {
        Some((_, v)) => {
            if !v.contains(&line) {
                v.push(line);
            }
        }
        None => groups.push((code.to_string(), vec![line])),
    }
}

impl Rule for Dotnet {
    fn name(&self) -> &'static str {
        "dotnet"
    }

    /// Build, test, restore, publish, pack and clean only (`dotnet run`,
    /// `dotnet ef` … print program or tool output).
    fn matches_command(&self, first_segment: &str) -> bool {
        let words: Vec<&str> = first_segment.split_whitespace().collect();
        matches!(
            words.as_slice(),
            [
                "dotnet" | "dotnet.exe",
                "build" | "test" | "restore" | "publish" | "pack" | "clean",
                ..
            ]
        )
    }

    fn matches_content(&self, lines: &[String]) -> bool {
        lines
            .iter()
            .any(|l| SIGNATURE_RE.is_match(l) || SUMMARY_RE.is_match(l.trim_start()))
    }

    fn trim(&self, lines: &[String]) -> Trimmed {
        let mut errors: Vec<(String, Vec<String>)> = Vec::new();
        let mut warnings: Vec<(String, Vec<String>)> = Vec::new();
        let mut tests: Vec<String> = Vec::new();
        let mut leftovers: Vec<String> = Vec::new();
        let mut summaries: Vec<String> = Vec::new();
        let mut elapsed: Vec<String> = Vec::new();

        let (mut failed, mut passed, mut skipped) = (0usize, 0usize, 0usize);
        let mut have_summary = false;
        let mut failed_summary = false;
        let mut build_ok = false;
        let mut build_failed = false;
        let (mut err_count, mut warn_count) = (None::<usize>, None::<usize>);

        let mut section = Section::None;
        let mut in_block = false;

        for line in lines {
            if let Some(c) = DIAG_RE.captures(line) {
                in_block = false;
                let proj = c
                    .name("proj")
                    .map(|p| format!(" [{}]", project_name(p.as_str())));
                let rendered = format!(
                    "{}({},{}): {} {}: {}{}",
                    &c["file"],
                    &c["line"],
                    &c["col"],
                    &c["sev"],
                    &c["code"],
                    &c["msg"],
                    proj.unwrap_or_default()
                );
                let groups = if &c["sev"] == "error" {
                    &mut errors
                } else {
                    &mut warnings
                };
                push_grouped(groups, &c["code"], rendered);
                continue;
            }
            let trimmed = line.trim();
            if let Some(c) = SUMMARY_RE.captures(trimmed) {
                in_block = false;
                have_summary = true;
                failed_summary |= &c[1] == "Failed";
                failed += c[2].parse::<usize>().unwrap_or(0);
                passed += c[3].parse::<usize>().unwrap_or(0);
                skipped += c[4].parse::<usize>().unwrap_or(0);
                summaries.push(trimmed.to_string());
                continue;
            }
            if FAILED_TEST_RE.is_match(line) {
                in_block = true;
                section = Section::None;
                tests.push(trimmed.to_string());
                continue;
            }
            if in_block {
                match trimmed {
                    "" => {}
                    "Error Message:" => {
                        section = Section::Message;
                        tests.push(line.trim_end().to_string());
                    }
                    "Stack Trace:" => {
                        section = Section::Stack;
                        tests.push(line.trim_end().to_string());
                    }
                    t if t.ends_with("Messages:") || t.ends_with("Output:") => {
                        section = Section::Other
                    }
                    t if t.starts_with("Passed ")
                        || t.starts_with("Skipped ")
                        || t.starts_with("Test Run ")
                        || t.starts_with("Time Elapsed") =>
                    {
                        in_block = false
                    }
                    t => match section {
                        Section::Message => tests.push(line.trim_end().to_string()),
                        Section::Stack if !NOISE_FRAMES.iter().any(|n| t.starts_with(n)) => {
                            tests.push(line.trim_end().to_string())
                        }
                        Section::Stack => {}
                        Section::None | Section::Other => {
                            if is_gate(line) {
                                leftovers.push(line.trim_end().to_string());
                            }
                        }
                    },
                }
                if in_block {
                    continue;
                }
            }
            if trimmed.starts_with("Time Elapsed") {
                elapsed.push(trimmed.to_string());
            } else if let Some(c) = COUNT_RE.captures(line) {
                let n = c[1].parse::<usize>().ok();
                if &c[2] == "Error" {
                    err_count = n;
                } else {
                    warn_count = n;
                }
            } else if trimmed.ends_with("Build succeeded.") {
                build_ok = true;
            } else if trimmed.ends_with("Build FAILED.") {
                build_failed = true;
            } else if !trimmed.starts_with("[xUnit.net")
                && !trimmed.contains("Done Building Project")
                && is_gate(line)
            {
                leftovers.push(line.trim_end().to_string());
            }
        }

        let diag_errors: usize = errors.iter().map(|(_, v)| v.len()).sum();
        let diag_warnings: usize = warnings.iter().map(|(_, v)| v.len()).sum();
        // Already gated by `is_gate`; `error_lines` would re-filter with a wider
        // word list that lacks `aborted`/`crashed`, so only dedupe here.
        let fallback = dedupe_keep_order(leftovers);

        // Errors, then failed tests and other failure lines, then warnings
        // (a few per code); the engine's cap drops from the end of the body.
        let mut body: Vec<String> = Vec::new();
        for (_, v) in errors {
            body.extend(v);
        }
        body.extend(tests);
        body.extend(fallback.iter().cloned());
        for (code, v) in warnings {
            let extra = v.len().saturating_sub(WARNINGS_PER_CODE);
            body.extend(v.into_iter().take(WARNINGS_PER_CODE));
            if extra > 0 {
                body.push(more_warnings(&code, extra));
            }
        }
        let body = dedupe_keep_order(body);
        let tail = dedupe_keep_order(summaries.into_iter().chain(elapsed));

        let fallback_errors = fallback
            .iter()
            .filter(|l| ERROR_WORD_RE.is_match(l))
            .count();
        let n_errors = err_count.unwrap_or(0).max(diag_errors + fallback_errors);
        let n_warnings = warn_count.unwrap_or(0).max(diag_warnings);

        let outcome = if diag_errors > 0
            || !fallback.is_empty()
            || build_failed
            || failed > 0
            || failed_summary
        {
            Outcome::Fail
        } else if build_ok || have_summary {
            Outcome::Pass
        } else {
            Outcome::Unknown
        };

        let (label, detail) = if have_summary {
            (
                "dotnet test",
                format!("{failed} failed, {passed} passed, {skipped} skipped"),
            )
        } else {
            (
                "dotnet build",
                format!("{n_errors} errors, {n_warnings} warnings"),
            )
        };

        Trimmed {
            verdict: verdict(label, outcome, &detail),
            body,
            tail,
            outcome,
        }
    }
}
