//! `npm` / `pnpm` / `yarn` install: summary, errors, peer warnings; deprecation
//! warnings are collapsed into one line and progress/funding/audit noise dropped.

use super::{Outcome, Rule, Trimmed, verdict};
use crate::collapse::dedupe_keep_order;
use regex::Regex;
use std::sync::LazyLock;

pub struct NodeInstall;

/// Deprecated package names listed in the collapsed line.
const MAX_NAMES: usize = 8;

static CONTENT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"added \d+ packages|npm ERR!|npm error|ERR_PNPM_|Progress: resolved|Packages: \+\d+")
        .unwrap()
});
/// `npm warn deprecated pkg@1.0.0: msg`, pnpm ` WARN  deprecated pkg@1.0.0: msg`,
/// yarn `warning pkg@1.0.0: msg ... deprecated ...`.
static DEPRECATED_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"^\s*(?:npm warn|npm WARN|WARN)\s+deprecated\s+(\S+?):(?:\s|$)|^warning (\S+?): .*\bdeprecated\b",
    )
    .unwrap()
});
static ERROR_BLOCK_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*(?:npm error|npm ERR!|error\s|ERR_PNPM_)|\bERR_PNPM_").unwrap());
static WARN_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*(?:npm warn|npm WARN|WARN|warning)\b").unwrap());
static PEER_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\bpeer\b|ERESOLVE").unwrap());
static NOISE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)^\s*(?:Progress:|npm notice|[+\-]{10,}\s*$)|\bfunding\b|npm fund|\baudit\b|To address (?:all )?issues|Some issues need review|a different dependency|^\s*\[\d/\d\]",
    )
    .unwrap()
});
static ADDED_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^added (\d+) packages?").unwrap());
static PNPM_PACKAGES_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^Packages: \+(\d+)").unwrap());
/// Lines that are kept as part of the result.
static SUMMARY_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"^(?:added \d+ packages?|removed \d+ packages?|changed \d+ packages?|up to date|Packages: [+\-]\d|Done in |Already up.to.date|success |found \d+ vulnerabilities|\d+ vulnerabilities|(?:dev)?[dD]ependencies:|optionalDependencies:|\s*[+\-] \S+ \S+)",
    )
    .unwrap()
});
static GATE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)\berror\b|\bfailed\b|\bfailure\b|\bERR!|\bcrashed\b|\baborted\b|\bENOENT\b|\bEACCES\b|\bE404\b|command not found|is not recognized",
    )
    .unwrap()
});
static OK_SUMMARY_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(?:added|removed|changed) \d+ packages?|^up to date|^Done in |^Already up.to.date|^success ").unwrap());

/// `@scope/pkg@1.2.3` -> `@scope/pkg`.
fn package_name(spec: &str) -> &str {
    match spec.rfind('@') {
        Some(i) if i > 0 => &spec[..i],
        _ => spec,
    }
}

impl Rule for NodeInstall {
    fn name(&self) -> &'static str {
        "node_install"
    }

    fn matches_command(&self, first_segment: &str) -> bool {
        let words: Vec<&str> = first_segment.split_whitespace().collect();
        let sub = words.get(1).copied();
        // `npm i -D x`, `yarn --frozen-lockfile`: flags are not subcommands.
        let bare = sub.is_none_or(|s| s.starts_with('-'));
        match words.first().copied() {
            Some("npm") => matches!(sub, Some("i" | "install" | "ci" | "add")),
            Some("pnpm") => matches!(sub, Some("i" | "install" | "add")),
            Some("yarn") => bare || matches!(sub, Some("install" | "add")),
            _ => false,
        }
    }

    fn matches_content(&self, lines: &[String]) -> bool {
        lines.iter().any(|l| CONTENT_RE.is_match(l))
    }

    fn trim(&self, lines: &[String]) -> Trimmed {
        let mut body: Vec<String> = Vec::new();
        let mut deprecated: Vec<String> = Vec::new();
        let mut deprecated_count = 0usize;
        let mut slot: Option<usize> = None;
        let mut hard_errors = 0usize;
        let mut added: Option<String> = None;
        let mut ok_summary = false;

        for raw in lines {
            let line = raw.trim_end();
            if line.trim().is_empty() {
                continue;
            }
            if let Some(c) = DEPRECATED_RE.captures(line) {
                let spec = c.get(1).or_else(|| c.get(2)).map_or("", |m| m.as_str());
                deprecated_count += 1;
                deprecated.push(package_name(spec).to_string());
                if slot.is_none() {
                    slot = Some(body.len());
                    body.push(String::new());
                }
            } else if ERROR_BLOCK_RE.is_match(line) {
                hard_errors += 1;
                body.push(line.to_string());
            } else if PEER_RE.is_match(line) || WARN_RE.is_match(line) {
                body.push(line.to_string());
            } else if NOISE_RE.is_match(line) && !GATE_RE.is_match(line) {
                // Progress, funding and audit nags.
            } else if SUMMARY_RE.is_match(line) {
                if let Some(c) = ADDED_RE.captures(line).or_else(|| PNPM_PACKAGES_RE.captures(line)) {
                    added.get_or_insert_with(|| format!("added {} packages", &c[1]));
                }
                if OK_SUMMARY_RE.is_match(line) {
                    ok_summary = true;
                }
                body.push(line.to_string());
            } else if GATE_RE.is_match(line) {
                hard_errors += 1;
                body.push(line.to_string());
            }
        }

        if let Some(i) = slot {
            let names = dedupe_keep_order(deprecated);
            let shown: Vec<&str> = names.iter().take(MAX_NAMES).map(String::as_str).collect();
            let more = if names.len() > MAX_NAMES { ", …" } else { "" };
            body[i] = format!("{deprecated_count} deprecation warnings ({}{more})", shown.join(", "));
        }
        let body = dedupe_keep_order(body);

        let outcome = if hard_errors > 0 {
            Outcome::Fail
        } else if ok_summary {
            Outcome::Pass
        } else {
            Outcome::Unknown
        };
        let detail = if outcome == Outcome::Pass { added.unwrap_or_default() } else { String::new() };
        Trimmed {
            verdict: verdict("install", outcome, &detail),
            body,
            outcome,
        }
    }
}
