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
