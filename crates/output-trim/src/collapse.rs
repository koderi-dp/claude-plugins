use regex::Regex;
use std::collections::HashSet;
use std::sync::LazyLock;

static TIMESTAMP: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?|[A-Z][a-z]{2} +\d{1,2} \d{2}:\d{2}:\d{2}",
    )
    .unwrap()
});
static GUID: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b").unwrap()
});
static HEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\b0x[0-9a-f]+\b|\b[0-9a-f]{8,}\b").unwrap());
static DIGITS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\d+").unwrap());
static SPACES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").unwrap());

/// The line with timestamps, hex ids, GUIDs and digit runs replaced by `#`,
/// whitespace squeezed.
pub fn template_key(line: &str) -> String {
    let s = TIMESTAMP.replace_all(line, "#");
    let s = GUID.replace_all(&s, "#");
    let s = HEX.replace_all(&s, "#");
    let s = DIGITS.replace_all(&s, "#");
    SPACES.replace_all(s.trim(), " ").into_owned()
}

/// Replace each run of at least `min_run` consecutive template-equal lines
/// with `(×N similar) <first line>`.
pub fn collapse_runs(lines: &[String], min_run: usize) -> Vec<String> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let key = template_key(&lines[i]);
        let mut j = i + 1;
        if !key.is_empty() {
            while j < lines.len() && template_key(&lines[j]) == key {
                j += 1;
            }
        }
        let n = j - i;
        if n >= min_run.max(2) {
            out.push(format!("(×{n} similar) {}", lines[i]));
        } else {
            out.extend_from_slice(&lines[i..j]);
        }
        i = j;
    }
    out
}

/// Drop exact duplicates, keeping the first occurrence.
pub fn dedupe_keep_order(lines: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = HashSet::new();
    lines.into_iter().filter(|l| seen.insert(l.clone())).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn template_strips_timestamps_and_numbers() {
        assert_eq!(
            template_key("2026-10-20T15:32:12.123Z info req 4512 done in 12ms"),
            template_key("2026-10-20T15:33:01.004Z info req 4513 done in 9ms")
        );
    }

    #[test]
    fn template_strips_guid() {
        assert_eq!(
            template_key("job 3f2504e0-4f89-11d3-9a0c-0305e82c3301 failed"),
            template_key("job 9a1b2c3d-0000-4abc-8def-123456789abc failed")
        );
    }

    #[test]
    fn template_distinguishes_words() {
        assert_ne!(template_key("GET /a 200"), template_key("POST /a 200"));
    }

    #[test]
    fn collapses_run() {
        let lines = s(&["retry 1", "retry 2", "retry 3", "retry 4", "retry 5"]);
        assert_eq!(collapse_runs(&lines, 3), s(&["(×5 similar) retry 1"]));
    }

    #[test]
    fn short_run_kept() {
        let lines = s(&["retry 1", "retry 2"]);
        assert_eq!(collapse_runs(&lines, 3), lines);
    }

    #[test]
    fn dedupe_preserves_order() {
        assert_eq!(dedupe_keep_order(s(&["b", "a", "b"])), s(&["b", "a"]));
    }
}
