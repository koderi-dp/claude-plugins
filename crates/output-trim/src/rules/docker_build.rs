//! `docker build` (BuildKit plain progress): the failing step with its last
//! output lines, every error line, and the final image line.

use super::{Outcome, Rule, Trimmed, verdict};
use crate::collapse::dedupe_keep_order;
use regex::Regex;
use std::collections::BTreeSet;
use std::sync::LazyLock;

pub struct DockerBuild;

/// Output lines of the failing step that are kept.
const STEP_TAIL: usize = 20;

static STEP_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^#(\d+) (.*)$").unwrap());
static HEADER_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^#\d+ \[").unwrap());
static STEP_ERROR_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^#(\d+) ERROR\b").unwrap());
static GATE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)\berror\b|failed to solve|\bfailed\b|\bfailure\b|did not complete|\bcrashed\b|\baborted\b|\bpanicked\b",
    )
    .unwrap()
});
static IMAGE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"naming to |writing image ").unwrap());

/// `#8 1.103 text` -> `1.103 text`.
fn strip_step_prefix(line: &str) -> &str {
    STEP_RE.captures(line).map_or(line, |c| c.get(2).unwrap().as_str())
}

impl Rule for DockerBuild {
    fn name(&self) -> &'static str {
        "docker_build"
    }

    fn matches_command(&self, first_segment: &str) -> bool {
        let words: Vec<&str> = first_segment.split_whitespace().collect();
        matches!(
            words.as_slice(),
            ["docker", "build", ..] | ["docker", "buildx", "build", ..] | ["docker", "compose", "build", ..]
        )
    }

    fn matches_content(&self, lines: &[String]) -> bool {
        lines.iter().any(|l| HEADER_RE.is_match(l))
    }

    fn trim(&self, lines: &[String]) -> Trimmed {
        let failing: BTreeSet<&str> = lines
            .iter()
            .filter_map(|l| STEP_ERROR_RE.captures(l).map(|c| c.get(1).unwrap().as_str()))
            .collect();

        // (line index, text) of everything kept, merged back in original order.
        let mut keep: Vec<(usize, String)> = Vec::new();
        let mut consumed = vec![false; lines.len()];
        let mut failed_steps: Vec<String> = Vec::new();

        for id in &failing {
            let prefix = format!("#{id} ");
            let mut output: Vec<usize> = Vec::new();
            for (i, line) in lines.iter().enumerate() {
                let Some(rest) = line.strip_prefix(&prefix) else {
                    continue;
                };
                consumed[i] = true;
                if rest.starts_with('[') {
                    keep.push((i, line.clone()));
                    failed_steps.push(rest.to_string());
                } else if STEP_ERROR_RE.is_match(line) {
                    keep.push((i, rest.to_string()));
                } else if !rest.starts_with("DONE ") && !rest.starts_with("CACHED") {
                    output.push(i);
                }
            }
            let from = output.len().saturating_sub(STEP_TAIL);
            for &i in &output[from..] {
                keep.push((i, strip_step_prefix(&lines[i]).to_string()));
            }
            // Older output of the failing step still goes through the error gate below.
            for &i in &output[..from] {
                consumed[i] = false;
            }
        }

        let mut image = false;
        for (i, line) in lines.iter().enumerate() {
            if consumed[i] {
                continue;
            }
            if GATE_RE.is_match(line) {
                keep.push((i, strip_step_prefix(line).to_string()));
            } else if IMAGE_RE.is_match(line) {
                image = true;
                keep.push((i, strip_step_prefix(line).to_string()));
            }
        }

        keep.sort_by_key(|(i, _)| *i);
        let body = dedupe_keep_order(keep.into_iter().map(|(_, l)| l));

        let failed = !failing.is_empty() || lines.iter().any(|l| GATE_RE.is_match(l));
        let outcome = if failed {
            Outcome::Fail
        } else if image {
            Outcome::Pass
        } else {
            Outcome::Unknown
        };
        let detail = match (outcome, failed_steps.first()) {
            (Outcome::Fail, Some(step)) => format!("failed at {step}"),
            (Outcome::Pass, _) => "image built".to_string(),
            _ => String::new(),
        };
        Trimmed {
            verdict: verdict("docker build", outcome, &detail),
            body,
            outcome,
        }
    }
}
