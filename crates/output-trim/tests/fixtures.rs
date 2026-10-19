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
        assert!(t.verdict.contains("0 failed, 3 passed, 0 skipped"), "{}", t.verdict);
    }

    #[test]
    fn build_pass_reduction() {
        let lines = fixture("dotnet", "build_pass");
        let dir = tempfile::tempdir().unwrap();
        let out = engine::apply(&lines, &Dotnet, LogTarget::SaveIn(dir.path()), false);
        assert_eq!(out.outcome, Outcome::Pass);
        if out.total_chars >= 1_500 {
            assert!(out.kept_chars * 5 <= out.total_chars, "{} of {}", out.kept_chars, out.total_chars);
        }
        assert!(out.text.contains("warning CS0168"), "{}", out.text);
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
