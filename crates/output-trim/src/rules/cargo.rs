//! `cargo build` / `test` / `clippy`: diagnostics, failed tests and summaries.

use super::{Outcome, Rule, Trimmed, verdict};
use regex::Regex;
use std::collections::HashSet;
use std::sync::LazyLock;

pub struct Cargo;

static CONTENT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?:\s*Compiling \S+ v|test result:|error\[E\d+\]|warning: )").unwrap()
});
static NOISE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"^\s*(?:Compiling|Checking|Finished|Running|Doc-tests|Fresh|Blocking|Downloaded|Downloading|Updating|Documenting|Locking|Adding)\b",
    )
    .unwrap()
});
static FINISHED_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*Finished\b").unwrap());
static DIAG_START_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(?:error|warning)(?:\[[A-Za-z0-9]+\])?:").unwrap());
static GENERATED_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^warning: .*\bgenerated \d+ warnings?\b").unwrap());
/// `error:` lines that wrap up other errors and must not be counted again.
static WRAPPER_ERROR_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^error: (?:could not compile|aborting due to|test failed|\d+ warnings? emitted|process didn't exit)")
        .unwrap()
});
static SECTION_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^---- .+ (?:stdout|stderr) ----$").unwrap());
static RESULT_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^test result: ").unwrap());
static PASSED_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(\d+) passed").unwrap());
static FAILED_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(\d+) failed").unwrap());
static TEST_QUIET_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^test .* \.\.\. (?:ok|ignored.*|bench:.*)$|^running \d+ tests?$").unwrap()
});
static TEST_FAILED_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^test .* \.\.\. FAILED$").unwrap());
static EXPLAIN_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^For more information about this error").unwrap());
/// Failure lines outside any structure the rule understands.
static GATE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)\berror\b|\bfailed\b|\bfailure\b|\bpanicked\b|\baborted\b|\bcrashed\b|didn't exit successfully|\bSTATUS_[A-Z_]+|\bSIGSEGV\b",
    )
    .unwrap()
});

#[derive(PartialEq)]
enum Mode {
    Normal,
    Diag,
    Section,
    FailList,
}

#[derive(Default)]
struct Acc {
    body: Vec<String>,
    seen: HashSet<String>,
    block: Vec<String>,
    errors: usize,
    warnings: usize,
    coded_errors: usize,
}

impl Acc {
    /// Close the open diagnostic block; identical blocks are kept once.
    fn flush_block(&mut self) {
        if self.block.is_empty() {
            return;
        }
        let block = std::mem::take(&mut self.block);
        if !self.seen.insert(block.join("\n")) {
            return;
        }
        let head = block[0].as_str();
        if head.starts_with("error") {
            self.coded_errors += 1;
            if !WRAPPER_ERROR_RE.is_match(head) {
                self.errors += 1;
            }
        } else {
            self.warnings += 1;
        }
        self.body.extend(block);
        self.body.push(String::new());
    }

    /// Single line kept once (summaries, failed test names, leftovers).
    fn push_once(&mut self, line: &str) -> bool {
        let fresh = self.seen.insert(line.to_string());
        if fresh {
            self.body.push(line.to_string());
        }
        fresh
    }
}

impl Rule for Cargo {
    fn name(&self) -> &'static str {
        "cargo"
    }

    fn matches_command(&self, first_segment: &str) -> bool {
        matches!(
            first_segment.split_whitespace().next(),
            Some("cargo") | Some("cargo.exe")
        )
    }

    fn matches_content(&self, lines: &[String]) -> bool {
        lines.iter().any(|l| CONTENT_RE.is_match(l))
    }

    fn trim(&self, lines: &[String]) -> Trimmed {
        let mut acc = Acc::default();
        let mut mode = Mode::Normal;
        let (mut failed, mut passed) = (0usize, 0usize);
        let (mut have_result, mut finished, mut failure_seen) = (false, false, false);
        let mut leftover_errors = 0usize;
        let mut trailing = 0usize;
        let mut listed: HashSet<String> = HashSet::new();

        for raw in lines {
            let line = raw.trim_end();
            let blank = line.trim().is_empty();
            if blank {
                trailing = 0;
            }

            match mode {
                Mode::Section => {
                    if line == "failures:" || SECTION_RE.is_match(line) || RESULT_RE.is_match(line)
                    {
                        mode = Mode::Normal;
                    } else {
                        if !blank {
                            acc.body.push(line.to_string());
                        }
                        continue;
                    }
                }
                Mode::Diag => {
                    if blank {
                        acc.flush_block();
                        mode = Mode::Normal;
                        continue;
                    }
                    if DIAG_START_RE.is_match(line) {
                        acc.flush_block();
                        mode = Mode::Normal;
                    } else {
                        acc.block.push(line.to_string());
                        continue;
                    }
                }
                Mode::FailList => {
                    if blank {
                        continue;
                    }
                    if line.starts_with(' ') {
                        listed.insert(line.trim().to_string());
                        acc.body.push(line.to_string());
                        continue;
                    }
                    mode = Mode::Normal;
                }
                Mode::Normal => {}
            }

            if SECTION_RE.is_match(line) {
                mode = Mode::Section;
                acc.body.push(line.to_string());
            } else if line == "failures:" {
                mode = Mode::FailList;
                acc.body.push(line.to_string());
            } else if RESULT_RE.is_match(line) {
                have_result = true;
                failure_seen |= line.starts_with("test result: FAILED");
                failed += FAILED_RE
                    .captures(line)
                    .map_or(0, |c| c[1].parse().unwrap_or(0));
                passed += PASSED_RE
                    .captures(line)
                    .map_or(0, |c| c[1].parse().unwrap_or(0));
                acc.body.push(line.to_string());
            } else if NOISE_RE.is_match(line) {
                finished |= FINISHED_RE.is_match(line);
            } else if TEST_QUIET_RE.is_match(line) || EXPLAIN_RE.is_match(line) {
            } else if TEST_FAILED_RE.is_match(line) {
                failure_seen = true;
                acc.push_once(line);
            } else if GENERATED_RE.is_match(line) {
                acc.push_once(line);
            } else if DIAG_START_RE.is_match(line) {
                mode = Mode::Diag;
                acc.block.push(line.to_string());
            } else if trailing > 0 && !blank && !line.starts_with("note: run with") {
                // Assertion detail that follows a kept panic/error line.
                trailing -= 1;
                acc.body.push(line.to_string());
            } else if GATE_RE.is_match(line) && acc.push_once(line) {
                leftover_errors += 1;
                trailing = 4;
            }
        }
        acc.flush_block();
        // `test x ... FAILED` is redundant once `x` is in the `failures:` list.
        acc.body.retain(|l| {
            let name = l
                .strip_prefix("test ")
                .and_then(|r| r.strip_suffix(" ... FAILED"));
            !(TEST_FAILED_RE.is_match(l) && name.is_some_and(|n| listed.contains(n)))
        });
        while acc.body.last().is_some_and(|l| l.is_empty()) {
            acc.body.pop();
        }

        let outcome = if acc.coded_errors > 0 || leftover_errors > 0 || failed > 0 || failure_seen {
            Outcome::Fail
        } else if finished || have_result {
            Outcome::Pass
        } else {
            Outcome::Unknown
        };

        let (label, detail) = if have_result {
            ("cargo test", format!("{failed} failed, {passed} passed"))
        } else {
            (
                "cargo build",
                format!(
                    "{} errors, {} warnings",
                    acc.errors + leftover_errors,
                    acc.warnings
                ),
            )
        };

        Trimmed {
            verdict: verdict(label, outcome, &detail),
            body: acc.body,
            outcome,
        }
    }
}
