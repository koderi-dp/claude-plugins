//! `vitest` / `jest` (also via `npm test` and friends): failing tests with
//! their assertion blocks, plus the run summary.

use super::{Outcome, Rule, Trimmed, verdict};
use regex::Regex;
use std::collections::HashSet;
use std::sync::LazyLock;

pub struct JsTest;

static CONTENT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*Test Files\s+\d+|^Tests:\s+\d+").unwrap());
/// Start of a failing test or suite: vitest ` FAIL  file > name`, jest `FAIL file`
/// and `×` / `✕` / `✗` / `✖` tree lines. Jest `● suite › test` is handled by
/// `is_header`; `● Console` is filtered out before that.
static HEADER_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*(?:FAIL\b|[×✗✕✖](?:\s|$))").unwrap());
static BULLET_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*●\s+(\S.*)$").unwrap());
static PASS_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*(?:[✓✔√](?:\s|$)|PASS\b)").unwrap());
static SEPARATOR_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*⎯+").unwrap());
/// Lines that always survive: the run summary.
static SUMMARY_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^\s*(?:Test Files\s+\d|Tests\s+\d|Duration\s|Tests:\s+\d|Test Suites:\s+\d|Snapshots:\s+\d|Time:\s)")
        .unwrap()
});
static TESTS_LINE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*Tests(?::|\s)\s*(.*)$").unwrap());
static FAILED_N_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(\d+) failed").unwrap());
static PASSED_N_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(\d+) passed").unwrap());
/// Source frame inside a failure: `  3|  code`, `> 3 | code`, `   |   ^`.
static FRAME_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*(?:>\s*)?\d*\s*\|").unwrap());
/// Stack frame: `at fn (file:1:2)` or vitest `❯ file:1:2`.
static STACK_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*(?:at\s|❯\s+\S+:\d+:\d+)").unwrap());
/// Vitest tree/file lines such as `❯ src/a.test.ts (2 tests | 2 failed)`.
static TREE_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*❯\s").unwrap());
/// Failure lines outside any structure the rule understands.
static GATE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)\berror\b|\bfailed\b|\bfailure\b|\bERR!|\bcrashed\b|\baborted\b|unhandled exception|unhandled rejection|\bENOENT\b|command not found|is not recognized",
    )
    .unwrap()
});

fn is_header(line: &str) -> bool {
    HEADER_RE.is_match(line) || BULLET_RE.is_match(line)
}

fn is_stack_outside_deps(line: &str) -> bool {
    STACK_RE.is_match(line) && !line.contains("node_modules") && !line.contains("node:internal")
}

impl Rule for JsTest {
    fn name(&self) -> &'static str {
        "jstest"
    }

    fn matches_command(&self, first_segment: &str) -> bool {
        let strip = |w: &str| {
            w.trim_end_matches(".cmd").trim_end_matches(".exe").to_string()
        };
        let words: Vec<String> = first_segment.split_whitespace().map(strip).collect();
        let w: Vec<&str> = words.iter().map(String::as_str).collect();
        let is_runner = |x: Option<&&str>| matches!(x, Some(&"vitest" | &"jest"));
        let is_test_script = |x: Option<&&str>| match x {
            Some(s) => *s == "test" || s.starts_with("test:"),
            None => false,
        };
        match w.first() {
            Some(&"vitest" | &"jest") => true,
            Some(&"npx") => is_runner(w.get(1)),
            Some(&"pnpm") => {
                is_test_script(w.get(1))
                    || (w.get(1) == Some(&"run") && is_test_script(w.get(2)))
                    || (matches!(w.get(1), Some(&"exec" | &"dlx")) && is_runner(w.get(2)))
            }
            Some(&"npm") => {
                matches!(w.get(1), Some(&"test" | &"t"))
                    || (w.get(1) == Some(&"run") && is_test_script(w.get(2)))
            }
            Some(&"yarn") => {
                is_test_script(w.get(1))
                    || (w.get(1) == Some(&"run") && is_test_script(w.get(2)))
            }
            _ => false,
        }
    }

    fn matches_content(&self, lines: &[String]) -> bool {
        lines.iter().any(|l| CONTENT_RE.is_match(l))
    }

    fn trim(&self, lines: &[String]) -> Trimmed {
        let mut body: Vec<String> = Vec::new();
        let mut seen_leftovers: HashSet<String> = HashSet::new();
        let mut in_block = false;
        let mut stack_done = false;
        let mut headers = 0usize;
        let mut leftovers = 0usize;
        let mut failed: Option<u64> = None;
        let mut passed: Option<u64> = None;

        for raw in lines {
            let line = raw.trim_end();
            if line.trim().is_empty() {
                continue;
            }
            if SEPARATOR_RE.is_match(line) {
                in_block = false;
                continue;
            }
            if SUMMARY_RE.is_match(line) {
                in_block = false;
                if let Some(c) = TESTS_LINE_RE.captures(line) {
                    if let Some(m) = FAILED_N_RE.captures(&c[1]) {
                        failed = m[1].parse().ok();
                    }
                    if let Some(m) = PASSED_N_RE.captures(&c[1]) {
                        passed = m[1].parse().ok();
                    }
                }
                body.push(line.trim().to_string());
                continue;
            }
            if BULLET_RE.captures(line).is_some_and(|c| c[1].starts_with("Console")) {
                in_block = false;
                continue;
            }
            if is_header(line) {
                // Jest's `FAIL path` is followed by the suite tree, not by details.
                in_block = !(line.starts_with("FAIL ") && !line.starts_with("FAIL  "));
                stack_done = false;
                headers += 1;
                body.push(line.to_string());
                continue;
            }
            if PASS_RE.is_match(line) {
                in_block = false;
                continue;
            }
            if in_block && (!TREE_RE.is_match(line) || STACK_RE.is_match(line)) {
                if FRAME_RE.is_match(line) {
                    continue;
                }
                if STACK_RE.is_match(line) {
                    if !stack_done && is_stack_outside_deps(line) {
                        stack_done = true;
                        body.push(line.to_string());
                    }
                    continue;
                }
                body.push(line.to_string());
                continue;
            }
            // Normal mode (a tree line also ends a block).
            in_block = false;
            if GATE_RE.is_match(line) && seen_leftovers.insert(line.to_string()) {
                leftovers += 1;
                body.push(line.to_string());
            }
        }

        let failed_n = failed.unwrap_or(0);
        let outcome = if failed_n > 0 || headers > 0 || leftovers > 0 {
            Outcome::Fail
        } else if passed.is_some() {
            Outcome::Pass
        } else {
            Outcome::Unknown
        };
        let mut parts: Vec<String> = Vec::new();
        if failed_n > 0 {
            parts.push(format!("{failed_n} failed"));
        }
        if let Some(p) = passed {
            parts.push(format!("{p} passed"));
        }
        if failed_n == 0 && leftovers > 0 {
            parts.push(format!("{leftovers} error lines"));
        }
        Trimmed {
            verdict: verdict("tests", outcome, &parts.join(", ")),
            body,
            outcome,
        }
    }
}
