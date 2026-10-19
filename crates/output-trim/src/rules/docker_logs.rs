//! `docker logs` / `docker compose logs`: the last lines verbatim, plus the
//! warnings, errors and stack traces from everything above them; repetitive
//! lines are collapsed.

use super::{Outcome, Rule, Trimmed, verdict};
use crate::collapse::collapse_runs;
use regex::Regex;
use std::sync::LazyLock;

pub struct DockerLogs;

/// Lines at the end of the log that are always kept verbatim.
const TAIL: usize = 40;
/// Minimum run length that is collapsed into `(×N similar) …`.
const MIN_RUN: usize = 3;

static ERROR_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)\b(warn|warning|error|err|fatal|exception|panic|crit|critical|fail|failed|failure|traceback)\b",
    )
    .unwrap()
});
static TRACEBACK_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^Traceback \(most recent call last\)").unwrap());
/// Stack-trace continuation lines, also when the run was collapsed.
static STACK_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"^(?:\(×\d+ similar\) )?\s*(?:at |---|File "|Caused by)"#).unwrap()
});

impl Rule for DockerLogs {
    fn name(&self) -> &'static str {
        "docker_logs"
    }

    fn matches_command(&self, first_segment: &str) -> bool {
        let words: Vec<&str> = first_segment.split_whitespace().collect();
        matches!(
            words.as_slice(),
            ["docker", "logs", ..] | ["docker", "compose", "logs", ..] | ["docker-compose", "logs", ..]
        )
    }

    fn matches_content(&self, _lines: &[String]) -> bool {
        false
    }

    fn trim(&self, lines: &[String]) -> Trimmed {
        let flagged = lines.iter().filter(|l| ERROR_RE.is_match(l)).count();
        let split = lines.len().saturating_sub(TAIL);
        let (head, tail) = lines.split_at(split);

        let mut body: Vec<String> = Vec::new();
        if !head.is_empty() {
            let collapsed = collapse_runs(head, MIN_RUN);
            let mut after_error = false;
            let mut in_traceback = false;
            let mut dropped = 0usize;
            for line in &collapsed {
                if in_traceback {
                    // Python: indented frames, then the unindented exception line.
                    in_traceback = line.starts_with(char::is_whitespace);
                    after_error = true;
                    body.push(line.clone());
                } else if ERROR_RE.is_match(line) {
                    after_error = true;
                    in_traceback = TRACEBACK_RE.is_match(line);
                    body.push(line.clone());
                } else if after_error && STACK_RE.is_match(line) {
                    body.push(line.clone());
                } else {
                    after_error = false;
                    if line.starts_with("(×") {
                        body.push(line.clone());
                    } else {
                        dropped += 1;
                    }
                }
            }
            if dropped > 0 {
                body.push(format!("… {dropped} other earlier lines omitted"));
            }
        }
        body.extend_from_slice(tail);

        let detail = format!("{} lines, {flagged} warnings/errors", lines.len());
        Trimmed {
            verdict: verdict("docker logs", Outcome::Unknown, &detail),
            body,
            outcome: Outcome::Unknown,
        }
    }
}
