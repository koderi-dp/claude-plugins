//! Claude Code hook modes: PostToolUse trimming and the SessionStart note.

use crate::command::{is_noisy, pipes_into_view};
use crate::engine::{self, LogTarget};
use crate::normalize::normalize;
use crate::{rules, store};
use serde::Deserialize;
use serde_json::json;
use std::io::{Read, Write};
use std::panic::{self, AssertUnwindSafe};
use std::path::{Path, PathBuf};

/// The hook only acts on output longer than this (in bytes of stdout + stderr).
const MIN_OUTPUT: usize = 2_000;

#[derive(Deserialize)]
struct PostInput {
    tool_name: String,
    #[serde(default)]
    tool_input: ToolInput,
    tool_response: ToolResponse,
}

#[derive(Deserialize, Default)]
struct ToolInput {
    #[serde(default)]
    command: String,
}

#[derive(Deserialize)]
struct ToolResponse {
    #[serde(default)]
    stdout: String,
    #[serde(default)]
    stderr: String,
    #[serde(default)]
    interrupted: bool,
    #[serde(default, rename = "isImage")]
    is_image: bool,
    #[serde(default, rename = "persistedOutputPath")]
    persisted_output_path: Option<PathBuf>,
}

/// The PostToolUse reply for a Bash call, or `None` to leave the output alone.
pub fn post(input: &str, store_dir: &Path) -> Option<String> {
    let v: PostInput = serde_json::from_str(input).ok()?;
    let cmd = v.tool_input.command.as_str();
    let resp = &v.tool_response;
    if v.tool_name != "Bash" || resp.interrupted || resp.is_image {
        return None;
    }
    if !is_noisy(cmd) || pipes_into_view(cmd) {
        return None;
    }
    let persisted = resp.persisted_output_path.as_deref();
    if persisted.is_none() && resp.stdout.len() + resp.stderr.len() <= MIN_OUTPUT {
        return None;
    }
    let rule = rules::by_command(cmd)?;

    let lines = match persisted {
        Some(p) => normalize(&std::fs::read(p).ok()?),
        None => {
            let mut text = resp.stdout.clone();
            if !resp.stderr.is_empty() {
                text.push('\n');
                text.push_str(&resp.stderr);
            }
            normalize(text.as_bytes())
        }
    };
    let target = match persisted {
        Some(p) => LogTarget::Existing(p),
        None => LogTarget::SaveIn(store_dir),
    };
    let out = engine::apply(&lines, rule, target, false);
    if !out.trimmed
        || out.text.contains("full log unavailable")
        || out.kept_chars * 10 > out.total_chars * 7
    {
        return None;
    }
    Some(
        json!({"hookSpecificOutput": {
            "hookEventName": "PostToolUse",
            "updatedToolOutput": {
                "stdout": out.text, "stderr": "", "interrupted": false, "isImage": false
            }
        }})
        .to_string(),
    )
}

/// The SessionStart reply; the last line of the note needs the exe path.
pub fn session_start(exe: Option<&Path>) -> String {
    let mut note = String::from(
        "output-trim is installed. For build, test, lint, install and log commands, pipe\n\
         through it instead of tail/head: `dotnet test 2>&1 | output-trim`. It keeps every\n\
         error, failed test and summary; the last line gives the path of the full log.",
    );
    if let Some(p) = exe {
        note.push_str(&format!(
            "\nIf `output-trim` is not found (e.g. PowerShell), use: \"{}\".",
            p.display()
        ));
    }
    json!({"hookSpecificOutput": {
        "hookEventName": "SessionStart", "additionalContext": note
    }})
    .to_string()
}

/// Runs `f` with panics silenced; any panic yields `None`.
fn silent<T>(f: impl FnOnce() -> Option<T>) -> Option<T> {
    panic::set_hook(Box::new(|_| {}));
    panic::catch_unwind(AssertUnwindSafe(f)).ok().flatten()
}

fn print(reply: Option<String>) {
    if let Some(s) = reply {
        let mut out = std::io::stdout().lock();
        let _ = out.write_all(s.as_bytes());
        let _ = out.flush();
    }
}

/// `output-trim hook post`: reads the hook JSON from stdin. Never fails.
pub fn post_main() {
    print(silent(|| {
        let mut buf = Vec::new();
        std::io::stdin().lock().read_to_end(&mut buf).ok()?;
        post(&String::from_utf8_lossy(&buf), &store::default_dir())
    }));
}

/// `output-trim hook session-start`: prints the note. Never fails.
pub fn session_start_main() {
    let mut sink = Vec::new();
    let _ = std::io::stdin().lock().read_to_end(&mut sink);
    print(silent(|| {
        Some(session_start(std::env::current_exe().ok().as_deref()))
    }));
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    use std::path::PathBuf;

    fn fixture(case: &str) -> String {
        let p: PathBuf = [
            env!("CARGO_MANIFEST_DIR"),
            "tests",
            "fixtures",
            "docker",
            &format!("{case}.txt"),
        ]
        .iter()
        .collect();
        String::from_utf8(std::fs::read(p).unwrap()).unwrap()
    }

    /// Mirrors the shape captured from Claude Code 2.1.301.
    fn input(cmd: &str, stdout: &str, persisted: Option<&Path>) -> String {
        let mut resp = json!({
            "stdout": stdout, "stderr": "", "interrupted": false,
            "isImage": false, "noOutputExpected": false
        });
        if let Some(p) = persisted {
            resp["persistedOutputPath"] = json!(p.to_string_lossy());
            resp["persistedOutputSize"] = json!(119_589);
        }
        json!({
            "session_id": "s-1", "hook_event_name": "PostToolUse", "tool_name": "Bash",
            "tool_input": {"command": cmd, "description": "d"},
            "tool_response": resp, "tool_use_id": "toolu_x", "duration_ms": 5
        })
        .to_string()
    }

    fn stdout_of(json: &str) -> String {
        let v: Value = serde_json::from_str(json).unwrap();
        assert_eq!(v["hookSpecificOutput"]["hookEventName"], "PostToolUse");
        let u = &v["hookSpecificOutput"]["updatedToolOutput"];
        assert_eq!(u["stderr"], "");
        assert_eq!(u["interrupted"], false);
        assert_eq!(u["isImage"], false);
        u["stdout"].as_str().unwrap().to_string()
    }

    fn count(dir: &Path) -> usize {
        std::fs::read_dir(dir).map(|d| d.count()).unwrap_or(0)
    }

    #[test]
    fn trims_docker_logs() {
        let dir = tempfile::tempdir().unwrap();
        let full = fixture("logs_repetitive");
        let out = post(&input("docker logs api", &full, None), dir.path()).expect("some");
        let text = stdout_of(&out);
        assert!(text.starts_with("[output-trim] docker logs"), "{text}");
        assert!(text.len() * 10 < full.len() * 3);
    }

    #[test]
    fn uses_persisted_file() {
        let dir = tempfile::tempdir().unwrap();
        let store = tempfile::tempdir().unwrap();
        let full = fixture("logs_repetitive");
        let file = dir.path().join("persisted.txt");
        std::fs::write(&file, &full).unwrap();
        let cut: String = full.chars().take(30_000).collect();
        let out = post(&input("docker logs api", &cut, Some(&file)), store.path()).expect("some");
        let text = stdout_of(&out);
        assert!(text.contains(&file.display().to_string()), "{text}");
        assert_eq!(count(store.path()), 0);
    }

    #[test]
    fn silent_for_git_diff() {
        let dir = tempfile::tempdir().unwrap();
        let big = fixture("logs_repetitive");
        assert!(post(&input("git diff", &big, None), dir.path()).is_none());
    }

    #[test]
    fn silent_for_non_build_subcommands() {
        let dir = tempfile::tempdir().unwrap();
        let big = fixture("logs_repetitive");
        for cmd in [
            "cargo run",
            "cargo test -- --nocapture",
            "cargo test -- --list",
            "cargo metadata",
            "dotnet run",
            "dotnet test --list-tests",
            "dotnet ef database update",
            "tsc --showConfig",
        ] {
            assert!(post(&input(cmd, &big, None), dir.path()).is_none(), "{cmd}");
        }
    }

    #[test]
    fn trims_commands_the_rules_claim() {
        let dir = tempfile::tempdir().unwrap();
        let big = fixture("logs_repetitive");
        for cmd in ["docker-compose logs api", "docker buildx build ."] {
            assert!(post(&input(cmd, &big, None), dir.path()).is_some(), "{cmd}");
        }
    }

    #[test]
    fn silent_when_already_piped() {
        let dir = tempfile::tempdir().unwrap();
        let big = fixture("logs_repetitive");
        assert!(post(&input("dotnet test | tail -20", &big, None), dir.path()).is_none());
        assert!(
            post(
                &input(r#"dotnet test | & "C:\x\output-trim.exe""#, &big, None),
                dir.path()
            )
            .is_none()
        );
    }

    #[test]
    fn silent_when_small() {
        let dir = tempfile::tempdir().unwrap();
        assert!(post(&input("dotnet build", &"x".repeat(500), None), dir.path()).is_none());
    }

    #[test]
    fn silent_when_not_worth_it() {
        let dir = tempfile::tempdir().unwrap();
        let errs: String = (0..22)
            .map(|i| format!("src/f{i}.ts({i},1): error TS2322: Type 'string' is not assignable to type 'number' {i} in this expression.\n"))
            .collect();
        assert!(errs.len() > 2000);
        assert!(post(&input("npx tsc --noEmit", &errs, None), dir.path()).is_none());
    }

    #[test]
    fn silent_on_bad_json() {
        let dir = tempfile::tempdir().unwrap();
        assert!(post("{not json", dir.path()).is_none());
    }

    #[test]
    fn silent_on_interrupted() {
        let dir = tempfile::tempdir().unwrap();
        let mut v: Value =
            serde_json::from_str(&input("docker logs api", &fixture("logs_repetitive"), None))
                .unwrap();
        v["tool_response"]["interrupted"] = json!(true);
        assert!(post(&v.to_string(), dir.path()).is_none());
    }

    #[test]
    fn silent_on_missing_persisted_file() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("nope.txt");
        let cut = "x".repeat(100);
        assert!(post(&input("docker logs api", &cut, Some(&missing)), dir.path()).is_none());
    }

    #[test]
    fn silent_when_save_fails() {
        let dir = tempfile::tempdir().unwrap();
        let blocker = dir.path().join("file");
        std::fs::write(&blocker, "x").unwrap();
        let bad = blocker.join("sub");
        let full = fixture("logs_repetitive");
        assert!(post(&input("docker logs api", &full, None), &bad).is_none());
    }

    #[test]
    fn silent_for_non_bash() {
        let dir = tempfile::tempdir().unwrap();
        let mut v: Value =
            serde_json::from_str(&input("docker logs api", &fixture("logs_repetitive"), None))
                .unwrap();
        v["tool_name"] = json!("PowerShell");
        assert!(post(&v.to_string(), dir.path()).is_none());
    }

    #[test]
    fn session_start_note_verbatim() {
        let note = |exe: Option<&Path>| {
            let v: Value = serde_json::from_str(&session_start(exe)).unwrap();
            assert_eq!(v["hookSpecificOutput"]["hookEventName"], "SessionStart");
            v["hookSpecificOutput"]["additionalContext"]
                .as_str()
                .unwrap()
                .to_string()
        };
        let base = "output-trim is installed. For build, test, lint, install and log commands, pipe\nthrough it instead of tail/head: `dotnet test 2>&1 | output-trim`. It keeps every\nerror, failed test and summary; the last line gives the path of the full log.";
        let with = note(Some(Path::new(r"C:\p\output-trim.exe")));
        assert_eq!(
            with,
            format!(
                "{base}\nIf `output-trim` is not found (e.g. PowerShell), use: \"C:\\p\\output-trim.exe\"."
            )
        );
        assert_eq!(note(None), base);
    }
}
