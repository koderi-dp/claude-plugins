//! Fixture-driven tests: real captured tool output through each rule.

use output_trim::normalize::normalize;
use std::path::PathBuf;

pub fn fixture(rule: &str, case: &str) -> Vec<String> {
    let path: PathBuf = [
        env!("CARGO_MANIFEST_DIR"),
        "tests",
        "fixtures",
        rule,
        &format!("{case}.txt"),
    ]
    .iter()
    .collect();
    let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    normalize(&bytes)
}

mod dotnet {
    use super::*;
    use output_trim::engine::{self, LogTarget};
    use output_trim::rules::dotnet::Dotnet;
    use output_trim::rules::{self, Outcome, Rule};

    const CS0029: &str = r"C:\src\Fx\Lib\Calc.cs(7,29): error CS0029: Cannot implicitly convert type 'string' to 'int' [Lib.csproj]";

    fn count(body: &[String], needle: &str) -> usize {
        body.iter().filter(|l| l.contains(needle)).count()
    }

    #[test]
    fn build_fail_keeps_error_once() {
        let t = Dotnet.trim(&fixture("dotnet", "build_fail"));
        assert_eq!(t.body.iter().filter(|l| l.as_str() == CS0029).count(), 1, "{:#?}", t.body);
        assert_eq!(t.outcome, Outcome::Fail);
        assert!(
            t.verdict.starts_with("[output-trim] dotnet build: FAILED — 1 errors"),
            "{}",
            t.verdict
        );
    }

    #[test]
    fn build_fail_parallel_dedupes() {
        let t = Dotnet.trim(&fixture("dotnet", "build_fail_parallel"));
        assert_eq!(count(&t.body, "error CS0029"), 1, "{:#?}", t.body);
        assert_eq!(t.body.iter().filter(|l| l.as_str() == CS0029).count(), 1);
        let prefix = regex::Regex::new(r"^\s*\d+>").unwrap();
        assert!(t.body.iter().all(|l| !prefix.is_match(l)), "{:#?}", t.body);
        assert_eq!(t.outcome, Outcome::Fail);
    }

    #[test]
    fn test_fail_keeps_failure() {
        let t = Dotnet.trim(&fixture("dotnet", "test_fail"));
        let text = t.body.join("\n");
        assert!(text.contains("Lib.Tests.CalcTests.Adds_Positive"), "{text}");
        assert!(text.contains("Expected: 4"), "{text}");
        assert!(text.contains("Actual:   5"), "{text}");
        assert!(text.contains("CalcTests.cs:line 8"), "{text}");
        assert!(!text.contains("at Xunit."), "{text}");
        assert!(!text.contains("at System."), "{text}");
        assert!(!text.contains("Determining projects"), "{text}");
        assert_eq!(t.outcome, Outcome::Fail);
        assert!(t.verdict.contains("1 failed, 2 passed, 0 skipped"), "{}", t.verdict);
        assert!(t.verdict.starts_with("[output-trim] dotnet test: FAILED"), "{}", t.verdict);
    }

    #[test]
    fn test_pass_is_short() {
        let t = Dotnet.trim(&fixture("dotnet", "test_pass"));
        assert_eq!(t.outcome, Outcome::Pass);
        let diag = regex::Regex::new(r"\): warning ").unwrap();
        let non_diag = t.body.iter().filter(|l| !diag.is_match(l)).count();
        assert!(non_diag <= 3, "{:#?}", t.body);
        assert!(t.body.iter().any(|l| l.starts_with("Passed!  - Failed:")), "{:#?}", t.body);
        assert!(t.verdict.contains("0 failed, 3 passed, 0 skipped"), "{}", t.verdict);
    }

    #[test]
    fn build_pass_keeps_warning() {
        let lines = fixture("dotnet", "build_pass");
        let dir = tempfile::tempdir().unwrap();
        let out = engine::apply(&lines, &Dotnet, LogTarget::SaveIn(dir.path()), false);
        assert_eq!(out.outcome, Outcome::Pass);
        assert!(out.text.contains("warning CS0168"), "{}", out.text);
    }

    #[test]
    fn build_fail_parallel_reduction() {
        let lines = fixture("dotnet", "build_fail_parallel");
        let dir = tempfile::tempdir().unwrap();
        let out = engine::apply(&lines, &Dotnet, LogTarget::SaveIn(dir.path()), false);
        assert!(out.total_chars >= 1_500);
        assert!(out.kept_chars * 5 <= out.total_chars, "{} of {}", out.kept_chars, out.total_chars);
    }

    fn lines(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn error_line_after_failed_block_is_kept() {
        let mut l = fixture("dotnet", "test_fail");
        let at = l.iter().position(|x| x.contains("Failed!")).unwrap();
        // Output section (not message/stack) inside the failed block.
        l.insert(at, "MSBUILD : error MSB1009: project file does not exist".into());
        l.insert(at, "  Standard Output Messages:".into());
        let t = Dotnet.trim(&l);
        assert!(t.body.iter().any(|x| x.contains("error MSB1009")), "{:#?}", t.body);
        assert_eq!(t.outcome, Outcome::Fail);
    }

    #[test]
    fn host_crash_is_fail_and_kept() {
        let t = Dotnet.trim(&lines(&[
            "Test run for C:\\src\\Fx\\Lib.Tests.dll (.NETCoreApp,Version=v10.0)",
            "The active test run was aborted. Reason: Test host process crashed",
            "Test Run Aborted.",
        ]));
        assert_eq!(t.outcome, Outcome::Fail);
        assert!(t.body.iter().any(|x| x.contains("crashed")), "{:#?}", t.body);
        assert!(t.body.iter().any(|x| x.contains("Test Run Aborted")), "{:#?}", t.body);
    }

    #[test]
    fn restore_error_is_fail() {
        let t = Dotnet.trim(&lines(&[
            "  Determining projects to restore...",
            r"C:\src\Fx\Lib\Lib.csproj : error NU1101: Unable to find package Nope. No packages exist with this id in source(s): nuget.org",
            "  Failed to restore C:\\src\\Fx\\Lib\\Lib.csproj (in 1.2 sec).",
        ]));
        assert_eq!(t.outcome, Outcome::Fail);
        assert!(t.body.iter().any(|x| x.contains("error NU1101")), "{:#?}", t.body);
        assert!(t.body.iter().any(|x| x.contains("Failed to restore")), "{:#?}", t.body);
        assert!(t.verdict.contains("FAILED"), "{}", t.verdict);
    }

    #[test]
    fn bare_failed_test_line_is_kept() {
        let t = Dotnet.trim(&lines(&["  Failed Lib.Tests.CalcTests.Adds_Positive"]));
        assert_eq!(t.outcome, Outcome::Fail);
        assert!(t.body.iter().any(|x| x.contains("Adds_Positive")));
    }

    #[test]
    fn detects_by_content() {
        for case in ["test_fail", "build_fail", "build_pass", "test_pass"] {
            assert_eq!(rules::by_content(&fixture("dotnet", case)).name(), "dotnet", "{case}");
        }
    }

    #[test]
    fn detects_by_command() {
        assert_eq!(rules::by_command("dotnet test --no-build").map(|r| r.name()), Some("dotnet"));
        assert!(rules::by_command("dotnetx foo").is_none());
    }
}

mod cargo {
    use super::*;
    use output_trim::engine::{self, LogTarget};
    use output_trim::rules::cargo::Cargo;
    use output_trim::rules::{self, Outcome, Rule};

    fn lines(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    fn reduction(case: &str) -> (usize, usize) {
        let l = fixture("cargo", case);
        let dir = tempfile::tempdir().unwrap();
        let out = engine::apply(&l, &Cargo, LogTarget::SaveIn(dir.path()), false);
        (out.kept_chars, out.total_chars)
    }

    #[test]
    fn test_fail_keeps_failure_and_summary() {
        let t = Cargo.trim(&fixture("cargo", "test_fail"));
        let text = t.body.join("\n");
        assert!(text.contains("adds_two_positive_numbers_with_a_wrong_expectation"), "{text}");
        assert!(text.contains("assertion `left == right` failed"), "{text}");
        assert!(text.contains("left: 2"), "{text}");
        assert!(text.contains("right: 3"), "{text}");
        assert!(text.contains("test result: FAILED. 150 passed; 1 failed"), "{text}");
        assert!(text.contains("warning: unused variable: `unused_value`"), "{text}");
        assert!(!text.contains("... ok"), "{text}");
        assert!(!text.contains("Compiling"), "{text}");
        assert_eq!(t.outcome, Outcome::Fail);
        assert!(
            t.verdict.starts_with("[output-trim] cargo test: FAILED — 1 failed, 150 passed"),
            "{}",
            t.verdict
        );
    }

    #[test]
    fn test_fail_is_reduced() {
        let (kept, total) = reduction("test_fail");
        assert!(total >= 1_500, "{total}");
        assert!(kept * 5 <= total, "{kept} of {total}");
    }

    #[test]
    fn test_pass_is_reduced_and_passes() {
        let t = Cargo.trim(&fixture("cargo", "test_pass"));
        assert_eq!(t.outcome, Outcome::Pass);
        assert!(t.body.iter().all(|l| !l.contains("... ok") && !l.contains("Doc-tests")), "{:#?}", t.body);
        assert!(t.body.iter().any(|l| l.starts_with("test result: ok. 150 passed")), "{:#?}", t.body);
        assert!(t.body.iter().any(|l| l.contains("unused variable: `unused_value`")), "{:#?}", t.body);
        assert!(t.verdict.contains("0 failed, 150 passed"), "{}", t.verdict);
        let (kept, total) = reduction("test_pass");
        assert!(total >= 1_500, "{total}");
        assert!(kept * 5 <= total, "{kept} of {total}");
    }

    #[test]
    fn build_fail_keeps_error_block() {
        let t = Cargo.trim(&fixture("cargo", "build_fail"));
        let text = t.body.join("\n");
        assert!(text.contains("error[E0308]: mismatched types"), "{text}");
        assert!(text.contains("--> src\\lib.rs:307:39"), "{text}");
        assert!(text.contains("expected `i32`, found `&str`"), "{text}");
        assert!(text.contains("expected due to this"), "{text}");
        assert!(text.contains("could not compile"), "{text}");
        assert!(!text.contains("Compiling"), "{text}");
        assert_eq!(t.outcome, Outcome::Fail);
        assert!(
            t.verdict.starts_with("[output-trim] cargo build: FAILED — 1 errors, 1 warnings"),
            "{}",
            t.verdict
        );
    }

    #[test]
    fn build_warn_passes_and_keeps_warning() {
        let t = Cargo.trim(&fixture("cargo", "build_warn"));
        let text = t.body.join("\n");
        assert_eq!(t.outcome, Outcome::Pass);
        assert!(text.contains("warning: unused variable: `unused_value`"), "{text}");
        assert!(text.contains("--> src\\lib.rs:2:28"), "{text}");
        assert!(text.contains("generated 1 warning"), "{text}");
        assert!(!text.contains("Compiling") && !text.contains("Finished"), "{text}");
        assert!(t.verdict.contains("0 errors, 1 warnings"), "{}", t.verdict);
    }

    #[test]
    fn clippy_keeps_lint_names() {
        let t = Cargo.trim(&fixture("cargo", "clippy_warn"));
        let text = t.body.join("\n");
        assert!(text.contains("clippy::ptr_arg"), "{text}");
        assert!(text.contains("clippy::len_zero"), "{text}");
        assert!(text.contains("v.is_empty()"), "{text}");
        assert!(!text.contains("Checking"), "{text}");
        assert_eq!(t.outcome, Outcome::Pass);
        assert!(t.verdict.contains("0 errors, 3 warnings"), "{}", t.verdict);
    }

    #[test]
    fn unexpected_panic_line_outside_sections_is_kept() {
        let mut l = fixture("cargo", "test_pass");
        let at = l.iter().position(|x| x.trim_start().starts_with("Finished")).unwrap();
        l.insert(at, "thread 'main' panicked at src/main.rs:1:1: boom".into());
        let t = Cargo.trim(&l);
        assert!(t.body.iter().any(|x| x.contains("panicked")), "{:#?}", t.body);
        assert_eq!(t.outcome, Outcome::Fail);
    }

    #[test]
    fn error_line_after_failures_list_is_kept() {
        let mut l = fixture("cargo", "test_fail");
        let at = l.iter().position(|x| x.starts_with("test result:")).unwrap();
        l.insert(at, "something went wrong: error while loading shared libraries".into());
        let t = Cargo.trim(&l);
        assert!(t.body.iter().any(|x| x.contains("shared libraries")), "{:#?}", t.body);
        assert_eq!(t.outcome, Outcome::Fail);
    }

    #[test]
    fn crate_names_with_error_do_not_fail() {
        let t = Cargo.trim(&lines(&[
            "   Compiling error-chain v0.12.4",
            "test errors::handles_error_case ... ok",
            "test errors::slow_error_case ... ignored",
            "test result: ok. 1 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.00s",
        ]));
        assert_eq!(t.outcome, Outcome::Pass);
        assert_eq!(t.body.len(), 1, "{:#?}", t.body);
    }

    #[test]
    fn failed_test_without_section_is_fail() {
        let t = Cargo.trim(&lines(&["test a::b ... FAILED"]));
        assert_eq!(t.outcome, Outcome::Fail);
        assert!(t.body.iter().any(|x| x.contains("a::b")));
    }

    #[test]
    fn sums_results_across_binaries() {
        let t = Cargo.trim(&lines(&[
            "test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s",
            "test result: FAILED. 2 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s",
        ]));
        assert!(t.verdict.contains("1 failed, 5 passed"), "{}", t.verdict);
        assert_eq!(t.outcome, Outcome::Fail);
        assert_eq!(t.body.len(), 2);
    }

    #[test]
    fn detects_by_content() {
        for case in ["test_fail", "test_pass", "build_fail", "build_warn", "clippy_warn"] {
            assert_eq!(rules::by_content(&fixture("cargo", case)).name(), "cargo", "{case}");
        }
    }

    #[test]
    fn detects_by_command() {
        assert_eq!(rules::by_command("cargo test --lib").map(|r| r.name()), Some("cargo"));
        assert_eq!(rules::by_command("cd x && cargo clippy | tail").map(|r| r.name()), Some("cargo"));
        assert!(rules::by_command("cargox build").is_none());
    }
}

mod cargo_followups {
    use super::*;
    use output_trim::rules::cargo::Cargo;
    use output_trim::rules::{Outcome, Rule};

    #[test]
    fn failed_line_dropped_when_listed() {
        let t = Cargo.trim(&fixture("cargo", "test_fail"));
        assert!(t.body.iter().all(|l| !l.ends_with(" ... FAILED")), "{:#?}", t.body);
        assert!(
            t.body
                .iter()
                .any(|l| l.trim() == "tests::adds_two_positive_numbers_with_a_wrong_expectation"),
            "{:#?}",
            t.body
        );
    }

    #[test]
    fn failed_line_kept_when_not_listed() {
        let t = Cargo.trim(&["test a::b ... FAILED".to_string()]);
        assert!(t.body.iter().any(|l| l.contains("a::b ... FAILED")));
    }

    #[test]
    fn panic_outside_section_keeps_assertion_detail() {
        let l: Vec<String> = [
            "thread 'main' panicked at src/main.rs:3:5:",
            "assertion `left == right` failed",
            "  left: 2",
            " right: 3",
            "note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let t = Cargo.trim(&l);
        let text = t.body.join("\n");
        assert!(text.contains("assertion `left == right` failed"), "{text}");
        assert!(text.contains("left: 2") && text.contains("right: 3"), "{text}");
        assert!(!text.contains("RUST_BACKTRACE"), "{text}");
        assert_eq!(t.outcome, Outcome::Fail);
    }
}
