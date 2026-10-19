//! Command-string parsing shared by rule selection and the hook gates.

/// Commands whose output the hook considers noisy (matched on word boundaries).
const NOISY: &[&str] = &[
    "dotnet",
    "cargo",
    "npm",
    "pnpm",
    "yarn",
    "npx",
    "tsc",
    "vitest",
    "jest",
    "docker logs",
    "docker compose logs",
    "docker build",
    "docker compose build",
];

/// Commands that already trim or filter what they receive on stdin (lowercase).
const VIEWERS: &[&str] = &[
    "output-trim",
    "tail",
    "head",
    "grep",
    "select-object",
    "select-string",
];

#[derive(Clone, Copy, PartialEq, Eq)]
enum Sep {
    Pipe,
    And,
    Or,
    Semi,
}

/// Split at unquoted `|`, `&&`, `||` and `;`. Each item is the segment text and
/// the separator that follows it (`None` for the last segment).
fn split_segments(cmd: &str) -> Vec<(&str, Option<Sep>)> {
    let bytes = cmd.as_bytes();
    let mut out = Vec::new();
    let mut quote: Option<u8> = None;
    let mut start = 0;
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        if let Some(q) = quote {
            if c == q {
                quote = None;
            }
            i += 1;
            continue;
        }
        let (sep, len) = match c {
            b'"' | b'\'' => {
                quote = Some(c);
                i += 1;
                continue;
            }
            b'|' if bytes.get(i + 1) == Some(&b'|') => (Sep::Or, 2),
            b'|' => (Sep::Pipe, 1),
            b'&' if bytes.get(i + 1) == Some(&b'&') => (Sep::And, 2),
            b';' => (Sep::Semi, 1),
            _ => {
                i += 1;
                continue;
            }
        };
        out.push((&cmd[start..i], Some(sep)));
        i += len;
        start = i;
    }
    out.push((&cmd[start..], None));
    out
}

fn is_cd(segment: &str) -> bool {
    let s = segment.trim();
    s == "cd"
        || s.strip_prefix("cd")
            .is_some_and(|r| r.starts_with(char::is_whitespace))
}

/// The first command of the pipeline, skipping leading `cd <dir> &&` / `cd <dir>;`.
pub fn first_segment(cmd: &str) -> &str {
    for (text, sep) in split_segments(cmd) {
        if is_cd(text) && matches!(sep, Some(Sep::And | Sep::Semi)) {
            continue;
        }
        return text.trim();
    }
    cmd.trim()
}

/// Whether `s` starts with `prefix` followed by end of string or whitespace.
fn starts_with_word(s: &str, prefix: &str) -> bool {
    s.strip_prefix(prefix)
        .is_some_and(|r| r.is_empty() || r.starts_with(char::is_whitespace))
}

/// Whether the segment invokes `output-trim` by path or with an `.exe` suffix,
/// optionally behind the PowerShell call operator and quotes
/// (`& "C:\x\output-trim.exe"`, `./output-trim`). `seg` is lowercase.
fn invokes_output_trim(seg: &str) -> bool {
    let mut s = seg.trim_start();
    if let Some(rest) = s.strip_prefix('&') {
        s = rest.trim_start();
    }
    let token = match s.chars().next() {
        Some(q @ ('"' | '\'')) => s[1..].split(q).next().unwrap_or(""),
        _ => s.split_whitespace().next().unwrap_or(""),
    };
    let name = token.rsplit(['/', '\\']).next().unwrap_or("");
    name.strip_suffix(".exe").unwrap_or(name) == "output-trim"
}

/// True when any unquoted `|` feeds a segment that already trims or views output.
pub fn pipes_into_view(cmd: &str) -> bool {
    let segments = split_segments(cmd);
    segments.windows(2).any(|w| {
        w[0].1 == Some(Sep::Pipe) && {
            let next = w[1].0.trim().to_lowercase();
            VIEWERS.iter().any(|v| starts_with_word(&next, v)) || invokes_output_trim(&next)
        }
    })
}

/// True when the first segment starts with an entry of the noisy-command list.
pub fn is_noisy(cmd: &str) -> bool {
    let seg = first_segment(cmd)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    NOISY.iter().any(|n| starts_with_word(&seg, n))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_segment_plain() {
        assert_eq!(first_segment("dotnet test"), "dotnet test");
    }

    #[test]
    fn first_segment_skips_cd_and_cuts_pipe() {
        assert_eq!(
            first_segment(r#"cd "C:\My Repo" && dotnet test | Select-Object -Last 20"#),
            "dotnet test"
        );
    }

    #[test]
    fn first_segment_skips_multiple_cd() {
        assert_eq!(
            first_segment("cd a; cd b && cargo test -- --nocapture"),
            "cargo test -- --nocapture"
        );
    }

    #[test]
    fn first_segment_ignores_quoted_pipe() {
        assert_eq!(first_segment(r#"echo "a|b" && x"#), r#"echo "a|b""#);
        assert_eq!(first_segment("echo 'a;b' || x"), "echo 'a;b'");
    }

    #[test]
    fn first_segment_keeps_redirects() {
        assert_eq!(first_segment("cargo test 2>&1 | tail"), "cargo test 2>&1");
    }

    #[test]
    fn pipes_into_view_cases() {
        assert!(pipes_into_view("dotnet test 2>&1 | tail -20"));
        assert!(pipes_into_view("docker logs x | Select-Object -Last 5"));
        assert!(pipes_into_view("cargo test 2>&1 | output-trim"));
        assert!(!pipes_into_view("cargo test"));
        assert!(!pipes_into_view("cargo test || tail -1"));
        assert!(!pipes_into_view(r#"echo "a | tail" && x"#));
        assert!(!pipes_into_view("cargo test | tailor"));
    }

    #[test]
    fn pipes_into_view_qualified_output_trim() {
        assert!(pipes_into_view(r"cargo test 2>&1 | output-trim.exe"));
        assert!(pipes_into_view(r"cargo test | C:\tools\output-trim.exe"));
        assert!(pipes_into_view(
            r#"cargo test | "C:/Program Files/x/output-trim.exe""#
        ));
        assert!(pipes_into_view("cargo test | ./output-trim"));
        assert!(pipes_into_view(
            r#"cargo test | & "C:\x y\output-trim.exe""#
        ));
        assert!(pipes_into_view(r"cargo test | & C:\x\OUTPUT-TRIM.EXE -v"));
        assert!(!pipes_into_view(r"cargo test | C:\x\output-trimmer.exe"));
        assert!(!pipes_into_view(r"cargo test | C:\x\not-output-trim.exe"));
    }

    #[test]
    fn is_noisy_true() {
        assert!(is_noisy("npx tsc --noEmit"));
        assert!(is_noisy("docker compose logs api"));
        assert!(is_noisy("pnpm install"));
        assert!(is_noisy(r#"cd "C:\My Repo" && dotnet test"#));
    }

    #[test]
    fn is_noisy_false() {
        assert!(!is_noisy("git diff"));
        assert!(!is_noisy("docker ps"));
        assert!(!is_noisy("sed -n 1,5p f"));
        assert!(!is_noisy("dotnetfoo"));
    }
}
