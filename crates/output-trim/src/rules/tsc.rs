//! TypeScript compiler (`tsc`): errors as `file:line TSnnnn msg`, no code frames.

use super::{Outcome, Rule, Trimmed, verdict};
use crate::collapse::dedupe_keep_order;
use regex::Regex;
use std::collections::{BTreeSet, HashMap};
use std::sync::LazyLock;

pub struct Tsc;

/// Errors shown in full; the rest are summarised by count.
const MAX_ERRORS: usize = 30;
/// Codes listed in the `by code:` line.
const MAX_CODES: usize = 10;

static CONTENT_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"error TS\d+:").unwrap());
/// `file(line,col): error TSnnnn: msg`
static PAREN_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(.+?)\((\d+),\d+\): error (TS\d+): (.*)$").unwrap());
/// `file:line:col - error TSnnnn: msg`
static COLON_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(.+?):(\d+):\d+ - error (TS\d+): (.*)$").unwrap());
/// Errors that belong to no file, e.g. `error TS5023: Unknown compiler option`.
static GLOBAL_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^error (TS\d+): (.*)$").unwrap());
/// Pretty-mode code frame: `12   return x;`, squiggles, or an indented frame line.
static FRAME_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*(?:\d+(?:\s|$)|[~^]+\s*$)").unwrap());
/// Related information: `  file:line:col - text`.
static RELATED_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s+\S.*:\d+:\d+ - ").unwrap());
/// Pretty-mode summary: `Found N errors...`, `Errors  Files`, `     2  src/a.ts:5`.
static SUMMARY_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?:Found \d+ errors?\b|Errors\s+Files\s*$|\s+\d+\s+\S+:\d+\s*$)").unwrap()
});
/// Failure lines outside any structure the rule understands.
static GATE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)\berror\b|\bfailed\b|\bfailure\b|\bERR!|\bcrashed\b|\baborted\b|unhandled exception|command not found|is not recognized|\bENOENT\b",
    )
    .unwrap()
});

struct Diag {
    file: String,
    line: String,
    code: String,
    msg: String,
    /// Continuation lines of the message (elaborations), trimmed.
    chain: Vec<String>,
}

fn parse_error(line: &str) -> Option<Diag> {
    let (file, line_no, code, msg) =
        if let Some(c) = PAREN_RE.captures(line).or_else(|| COLON_RE.captures(line)) {
            (c[1].to_string(), c[2].to_string(), c[3].to_string(), c[4].to_string())
        } else {
            let c = GLOBAL_RE.captures(line)?;
            ("(global)".to_string(), String::new(), c[1].to_string(), c[2].to_string())
        };
    Some(Diag { file, line: line_no, code, msg, chain: Vec::new() })
}

impl Rule for Tsc {
    fn name(&self) -> &'static str {
        "tsc"
    }

    fn matches_command(&self, first_segment: &str) -> bool {
        let is_tsc = |w: Option<&str>| matches!(w, Some("tsc" | "tsc.exe" | "tsc.cmd"));
        let mut words = first_segment.split_whitespace();
        match words.next() {
            Some("npx" | "pnpm") => {
                let second = words.next();
                is_tsc(second) || (second == Some("exec") && is_tsc(words.next()))
            }
            first => is_tsc(first),
        }
    }

    fn matches_content(&self, lines: &[String]) -> bool {
        lines.iter().any(|l| CONTENT_RE.is_match(l))
    }

    fn trim(&self, lines: &[String]) -> Trimmed {
        let mut diags: Vec<Diag> = Vec::new();
        let mut leftovers: Vec<String> = Vec::new();
        // Inside the message of the last error (until the first blank line).
        let mut in_message = false;

        for raw in lines {
            let line = raw.trim_end();
            if line.trim().is_empty() {
                in_message = false;
                continue;
            }
            if let Some(d) = parse_error(line) {
                diags.push(d);
                in_message = true;
            } else if SUMMARY_RE.is_match(line) || FRAME_RE.is_match(line) {
                // Counts and code frames are redundant with the error lines.
            } else if in_message && line.starts_with(' ') && !RELATED_RE.is_match(line) {
                if let Some(d) = diags.last_mut() {
                    d.chain.push(line.trim().to_string());
                }
            } else if GATE_RE.is_match(line) {
                leftovers.push(line.to_string());
            }
        }
        let leftovers = dedupe_keep_order(leftovers);

        // Group by file; files and errors within a file keep first-seen order.
        let mut order: Vec<&str> = Vec::new();
        let mut groups: HashMap<&str, Vec<&Diag>> = HashMap::new();
        for d in &diags {
            groups
                .entry(d.file.as_str())
                .or_insert_with(|| {
                    order.push(d.file.as_str());
                    Vec::new()
                })
                .push(d);
        }
        let grouped: Vec<&Diag> = order.iter().flat_map(|f| groups[f].iter().copied()).collect();

        let mut body: Vec<String> = Vec::new();
        let mut current: Option<&str> = None;
        for d in grouped.iter().take(MAX_ERRORS) {
            if current != Some(d.file.as_str()) {
                body.push(d.file.clone());
                current = Some(d.file.as_str());
            }
            let at = if d.line.is_empty() { String::new() } else { format!("{}:{} ", d.file, d.line) };
            body.push(format!("  {at}{} {}", d.code, d.msg));
            body.extend(d.chain.iter().map(|c| format!("    {c}")));
        }

        if grouped.len() > MAX_ERRORS {
            let hidden = &grouped[MAX_ERRORS..];
            let hidden_files: BTreeSet<&str> = hidden.iter().map(|d| d.file.as_str()).collect();
            body.push(format!("+{} more in {} files", hidden.len(), hidden_files.len()));

            let mut codes: Vec<(&str, usize)> = Vec::new();
            for d in &diags {
                match codes.iter_mut().find(|(c, _)| *c == d.code) {
                    Some(e) => e.1 += 1,
                    None => codes.push((d.code.as_str(), 1)),
                }
            }
            codes.sort_by_key(|c| std::cmp::Reverse(c.1)); // stable: ties keep first-seen order
            let mut parts: Vec<String> =
                codes.iter().take(MAX_CODES).map(|(c, n)| format!("{c}×{n}")).collect();
            if codes.len() > MAX_CODES {
                parts.push(format!("+{} more codes", codes.len() - MAX_CODES));
            }
            body.push(format!("by code: {}", parts.join(", ")));
        }

        body.extend(leftovers.iter().cloned());

        let total = diags.len() + leftovers.len();
        let outcome = if total > 0 { Outcome::Fail } else { Outcome::Pass };
        let detail = if total > 0 {
            format!("{total} errors in {} files", order.len().max(1))
        } else {
            String::new()
        };
        Trimmed {
            verdict: verdict("tsc", outcome, &detail),
            body,
            outcome,
        }
    }
}
