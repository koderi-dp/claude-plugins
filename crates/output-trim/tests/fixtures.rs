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

mod tsc {
    use super::*;
    use output_trim::engine::{self, LogTarget};
    use output_trim::rules::tsc::Tsc;
    use output_trim::rules::{self, Outcome, Rule};

    fn lines(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    fn count(body: &[String], needle: &str) -> usize {
        body.iter().filter(|l| l.contains(needle)).count()
    }

    fn reduction(case: &str) -> (usize, usize) {
        let l = fixture("tsc", case);
        let dir = tempfile::tempdir().unwrap();
        let out = engine::apply(&l, &Tsc, LogTarget::SaveIn(dir.path()), false);
        (out.kept_chars, out.total_chars)
    }

    #[test]
    fn few_keeps_codes_and_locations_without_frames() {
        let t = Tsc.trim(&fixture("tsc", "errors_few"));
        let text = t.body.join("
");
        for needle in [
            "src/app.ts:3 TS2322",
            "src/math.ts:5 TS2345",
            "src/math.ts:19 TS2551",
            "src/util.ts:3 TS2322",
        ] {
            assert!(text.contains(needle), "{needle}
{text}");
        }
        assert!(t.body.iter().all(|l| !l.contains("~~~")), "{text}");
        assert!(text.contains("missing the following properties from type 'User'"), "{text}");
        assert_eq!(t.outcome, Outcome::Fail);
        assert_eq!(t.verdict, "[output-trim] tsc: FAILED — 4 errors in 3 files");
    }

    #[test]
    fn few_is_reduced() {
        let (kept, total) = reduction("errors_few");
        assert!(total >= 1500, "{total}");
        assert!(kept * 100 <= total * 70, "kept {kept} of {total}");
    }

    #[test]
    fn many_caps_at_30_and_summarises_rest() {
        let t = Tsc.trim(&fixture("tsc", "errors_many"));
        assert_eq!(count(&t.body, "TS2322 Type"), 30, "{:#?}", t.body);
        assert_eq!(count(&t.body, "+50 more in 4 files"), 1, "{:#?}", t.body);
        assert_eq!(count(&t.body, "by code: TS2322×80"), 1, "{:#?}", t.body);
        assert_eq!(t.outcome, Outcome::Fail);
        assert_eq!(t.verdict, "[output-trim] tsc: FAILED — 80 errors in 5 files");
    }

    #[test]
    fn many_is_reduced() {
        let (kept, total) = reduction("errors_many");
        assert!(total >= 1500, "{total}");
        assert!(kept * 100 <= total * 60, "kept {kept} of {total}");
    }

    #[test]
    fn colon_format_is_parsed_and_grouped_in_first_seen_order() {
        let l = lines(&[
            "b.ts:2:5 - error TS2322: bad b",
            "",
            "2 let x: number = 's';",
            "      ~",
            "a.ts(7,1): error TS1005: ';' expected.",
            "b.ts:9:1 - error TS2304: Cannot find name 'q'.",
        ]);
        let t = Tsc.trim(&l);
        assert_eq!(
            t.body,
            lines(&[
                "b.ts",
                "  b.ts:2 TS2322 bad b",
                "  b.ts:9 TS2304 Cannot find name 'q'.",
                "a.ts",
                "  a.ts:7 TS1005 ';' expected.",
            ])
        );
        assert_eq!(t.verdict, "[output-trim] tsc: FAILED — 3 errors in 2 files");
    }

    #[test]
    fn no_errors_passes() {
        let t = Tsc.trim(&lines(&["npm notice run fx@1.0.0 npx"]));
        assert_eq!(t.outcome, Outcome::Pass);
        assert_eq!(t.verdict, "[output-trim] tsc: PASSED");
        assert!(t.body.is_empty());
    }

    #[test]
    fn unparsed_error_line_in_odd_position_is_kept() {
        let l = lines(&[
            "a.ts(1,1): error TS2322: bad",
            "",
            "1 const a: number = 's';",
            "  ~",
            "",
            "pkg-x: error TS2307: Cannot find module 'zzz'.",
            "tsc exited with fatal error while writing output",
        ]);
        let t = Tsc.trim(&l);
        let text = t.body.join("
");
        assert!(text.contains("pkg-x: error TS2307: Cannot find module 'zzz'."), "{text}");
        assert!(text.contains("fatal error while writing output"), "{text}");
        assert_eq!(t.outcome, Outcome::Fail);
        assert!(t.verdict.contains("3 errors in 1 files"), "{}", t.verdict);
    }

    #[test]
    fn error_text_inside_code_frame_is_not_a_leftover() {
        let l = lines(&[
            "a.ts:1:1 - error TS2322: bad",
            "",
            "1 throw new Error('error happened');",
            "  ~~~~",
        ]);
        let t = Tsc.trim(&l);
        assert_eq!(t.body, lines(&["a.ts", "  a.ts:1 TS2322 bad"]));
    }

    #[test]
    fn detects_by_content() {
        for case in ["errors_few", "errors_many"] {
            assert_eq!(rules::by_content(&fixture("tsc", case)).name(), "tsc", "{case}");
        }
    }

    #[test]
    fn detects_by_command() {
        for cmd in ["tsc --noEmit", "npx tsc -p .", "pnpm tsc", "pnpm exec tsc", "cd x && npx tsc | tail"] {
            assert_eq!(rules::by_command(cmd).map(|r| r.name()), Some("tsc"), "{cmd}");
        }
        assert!(rules::by_command("tscx").is_none());
        assert!(rules::by_command("npx eslint .").is_none());
    }
}

mod jstest {
    use super::*;
    use output_trim::engine::{self, LogTarget};
    use output_trim::rules::jstest::JsTest;
    use output_trim::rules::{self, Outcome, Rule};

    fn lines(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    fn reduction(case: &str) -> (usize, usize) {
        let l = fixture("jstest", case);
        let dir = tempfile::tempdir().unwrap();
        let out = engine::apply(&l, &JsTest, LogTarget::SaveIn(dir.path()), false);
        (out.kept_chars, out.total_chars)
    }

    #[test]
    fn fail_keeps_failures_and_drops_passes() {
        let t = JsTest.trim(&fixture("jstest", "vitest_fail"));
        let text = t.body.join("\n");
        assert!(text.contains("adds numbers wrongly"), "{text}");
        assert!(text.contains("compares totals wrongly"), "{text}");
        assert_eq!(text.matches("expected 1 to be 2").count(), 2, "{text}");
        assert!(text.contains("src/broken.test.ts:3:48"), "{text}");
        assert!(t.body.iter().all(|l| !l.contains('✓')), "{text}");
        assert!(t.body.iter().all(|l| !l.contains("expect(1).toBe(2)")), "code frames dropped: {text}");
        assert!(text.contains("Test Files  1 failed | 4 passed (5)"), "{text}");
        assert!(text.contains("Duration"), "{text}");
        assert_eq!(t.outcome, Outcome::Fail);
        assert_eq!(t.verdict, "[output-trim] tests: FAILED — 2 failed, 12 passed");
    }

    #[test]
    fn fail_is_reduced() {
        let (kept, total) = reduction("vitest_fail");
        assert!(total >= 1500, "{total}");
        assert!(kept * 100 <= total * 70, "kept {kept} of {total}");
    }

    #[test]
    fn pass_gives_short_body() {
        let t = JsTest.trim(&fixture("jstest", "vitest_pass"));
        assert_eq!(t.outcome, Outcome::Pass);
        assert!(t.body.len() <= 3, "{:#?}", t.body);
        assert!(t.body.iter().any(|l| l == "Tests  12 passed (12)"), "{:#?}", t.body);
        assert_eq!(t.verdict, "[output-trim] tests: PASSED — 12 passed");
    }

    #[test]
    fn tsc_error_before_vitest_output_is_kept() {
        let t = JsTest.trim(&fixture("jstest", "npm_test_tsc_then_vitest"));
        let text = t.body.join("\n");
        assert!(
            text.contains("src/typed.ts(2,9): error TS2322: Type 'string' is not assignable to type 'number'."),
            "{text}"
        );
        assert!(text.contains("adds numbers wrongly"), "{text}");
        assert_eq!(t.outcome, Outcome::Fail);
        assert_eq!(t.verdict, "[output-trim] tests: FAILED — 2 failed, 12 passed");
    }

    #[test]
    fn unexpected_error_lines_in_odd_positions_are_kept() {
        let l = lines(&[
            " RUN  v5.0.5 C:/src/js",
            "Error: spawn ENOENT before anything else",
            " ✓ src/a.test.ts (3 tests) 3ms",
            "Unhandled Rejection: socket crashed",
            "",
            " Test Files  1 passed (1)",
            "      Tests  3 passed (3)",
            "Error: worker exited after the summary",
        ]);
        let t = JsTest.trim(&l);
        for needle in [
            "Error: spawn ENOENT before anything else",
            "Unhandled Rejection: socket crashed",
            "Error: worker exited after the summary",
        ] {
            assert!(t.body.iter().any(|b| b == needle), "{needle}: {:#?}", t.body);
        }
        assert_eq!(t.outcome, Outcome::Fail);
    }

    #[test]
    fn mixed_tsc_and_vitest_output_is_claimed_by_jstest() {
        let l = fixture("jstest", "npm_test_tsc_then_vitest");
        let rule = rules::by_content(&l);
        assert_eq!(rule.name(), "jstest");
        let t = rule.trim(&l);
        let text = t.body.join("\n");
        assert!(text.contains("error TS2322"), "{text}");
        assert!(text.contains("expected 1 to be 2"), "{text}");
        assert_eq!(t.outcome, Outcome::Fail);
    }

    #[test]
    fn tsc_only_and_vitest_only_keep_their_rules() {
        assert_eq!(rules::by_content(&fixture("tsc", "errors_few")).name(), "tsc");
        assert_eq!(rules::by_content(&fixture("jstest", "vitest_fail")).name(), "jstest");
    }

    #[test]
    fn real_jest_output_keeps_failures_and_diff() {
        let t = JsTest.trim(&fixture("jstest", "jest_fail"));
        let text = t.body.join("\n");
        for needle in [
            "● sum › subtracts",
            "● sum › multiplies",
            "Expected: 1",
            "Received: 2",
            "-     3,",
            "+     2,",
            "at Object.toBe (t/sum.test.js:3:41)",
            "at Object.toEqual (t/sum.test.js:4:56)",
            "Tests:       2 failed, 3 passed, 5 total",
        ] {
            assert!(text.contains(needle), "{needle}\n{text}");
        }
        assert!(!text.contains("hello from test") && !text.contains("PASS"), "{text}");
        assert!(!text.contains("expect(3 - 1)"), "code frame dropped: {text}");
        assert_eq!(t.verdict, "[output-trim] tests: FAILED — 2 failed, 3 passed");
        assert_eq!(rules::by_content(&fixture("jstest", "jest_fail")).name(), "jstest");
        let l = fixture("jstest", "jest_fail");
        let dir = tempfile::tempdir().unwrap();
        let out = engine::apply(&l, &JsTest, LogTarget::SaveIn(dir.path()), false);
        assert!(out.total_chars >= 1500 && out.kept_chars * 100 <= out.total_chars * 70);
    }

    #[test]
    fn jest_style_failure_block_is_trimmed() {
        let l = lines(&[
            "FAIL src/sum.test.js",
            "  sum",
            "    ✓ adds (2 ms)",
            "    ✕ subtracts (3 ms)",
            "",
            "  ● sum › subtracts",
            "",
            "    expect(received).toBe(expected) // Object.is equality",
            "",
            "    Expected: 2",
            "    Received: 1",
            "",
            "      3 |   it('subtracts', () => {",
            "    > 4 |     expect(1).toBe(2);",
            "        |               ^",
            "      5 |   });",
            "",
            "      at Object.<anonymous> (node_modules/jest-circus/build/run.js:1:1)",
            "      at Object.<anonymous> (src/sum.test.js:4:15)",
            "      at Object.<anonymous> (src/other.js:9:9)",
            "",
            "  ● Console",
            "",
            "    console.log",
            "      noise",
            "",
            "Test Suites: 1 failed, 1 total",
            "Tests:       1 failed, 1 passed, 2 total",
            "Snapshots:   0 total",
            "Time:        0.5 s",
            "Ran all test suites.",
        ]);
        let t = JsTest.trim(&l);
        let text = t.body.join("\n");
        assert!(text.contains("● sum › subtracts"), "{text}");
        assert!(text.contains("Expected: 2") && text.contains("Received: 1"), "{text}");
        assert!(text.contains("src/sum.test.js:4:15"), "{text}");
        assert!(!text.contains("jest-circus") && !text.contains("other.js"), "{text}");
        assert!(!text.contains("adds") && !text.contains("noise") && !text.contains("Console"), "{text}");
        assert!(text.contains("Test Suites: 1 failed, 1 total"), "{text}");
        assert_eq!(t.verdict, "[output-trim] tests: FAILED — 1 failed, 1 passed");
    }

    #[test]
    fn detects_by_content() {
        for case in ["vitest_fail", "vitest_pass"] {
            assert_eq!(rules::by_content(&fixture("jstest", case)).name(), "jstest", "{case}");
        }
        assert!(JsTest.matches_content(&lines(&["Tests:       1 failed, 2 total"])));
    }

    #[test]
    fn detects_by_command() {
        for cmd in [
            "vitest run",
            "jest --ci",
            "npx vitest run",
            "npx jest",
            "npm test",
            "npm run test",
            "npm run test:unit",
            "pnpm test",
            "pnpm run test",
            "yarn test",
            "cd x && npm test | tail",
        ] {
            assert_eq!(rules::by_command(cmd).map(|r| r.name()), Some("jstest"), "{cmd}");
        }
        for cmd in ["npm run build", "npm install", "yarn", "pnpm install", "npx eslint ."] {
            assert_ne!(rules::by_command(cmd).map(|r| r.name()), Some("jstest"), "{cmd}");
        }
    }
}

mod node_install {
    use super::*;
    use output_trim::engine::{self, LogTarget};
    use output_trim::rules::node_install::NodeInstall;
    use output_trim::rules::{self, Outcome, Rule};

    fn lines(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    fn reduction(case: &str) -> (usize, usize) {
        let l = fixture("node_install", case);
        let dir = tempfile::tempdir().unwrap();
        let out = engine::apply(&l, &NodeInstall, LogTarget::SaveIn(dir.path()), false);
        (out.kept_chars, out.total_chars)
    }

    #[test]
    fn npm_install_keeps_summary_and_collapses_deprecations() {
        let t = NodeInstall.trim(&fixture("node_install", "npm_install"));
        let text = t.body.join("\n");
        assert!(text.contains("added 414 packages, and audited 415 packages in 48s"), "{text}");
        assert!(text.contains("38 vulnerabilities (8 moderate, 28 high, 2 critical)"), "{text}");
        for noise in ["Progress:", "fund", "audit fix", "npm audit"] {
            assert!(!text.contains(noise), "{noise}: {text}");
        }
        assert!(!text.contains("npm warn deprecated"), "{text}");
        let collapsed = "9 deprecation warnings (inflight, @humanwhocodes/config-array, rimraf, glob, har-validator, @humanwhocodes/object-schema, uuid, request, …)";
        assert_eq!(t.body.iter().filter(|l| l.as_str() == collapsed).count(), 1, "{text}");
        assert_eq!(t.outcome, Outcome::Pass);
        assert_eq!(t.verdict, "[output-trim] install: PASSED — added 414 packages");
    }

    #[test]
    fn npm_install_is_reduced() {
        let (kept, total) = reduction("npm_install");
        assert!(total >= 1500, "{total}");
        assert!(kept * 100 <= total * 70, "kept {kept} of {total}");
    }

    #[test]
    fn pnpm_install_keeps_packages_and_done() {
        let t = NodeInstall.trim(&fixture("node_install", "pnpm_install"));
        let text = t.body.join("\n");
        assert!(text.contains("Packages: +405"), "{text}");
        assert!(text.contains("Done in 23.3s using pnpm v10.15.0"), "{text}");
        assert!(text.contains("+ vitest 5.0.5"), "{text}");
        assert!(text.contains("5 deprecated subdependencies found"), "{text}");
        assert!(t.body.iter().all(|l| !l.contains("Progress:") && !l.starts_with("++++")), "{text}");
        assert!(text.contains("4 deprecation warnings (request, rimraf, glob, eslint)"), "{text}");
        assert_eq!(t.outcome, Outcome::Pass);
        assert_eq!(t.verdict, "[output-trim] install: PASSED — added 405 packages");
    }

    #[test]
    fn pnpm_install_is_reduced() {
        let (kept, total) = reduction("pnpm_install");
        assert!(total >= 1500, "{total}");
        assert!(kept * 100 <= total * 50, "kept {kept} of {total}");
    }

    #[test]
    fn npm_err_keeps_404_error() {
        let t = NodeInstall.trim(&fixture("node_install", "npm_err"));
        let text = t.body.join("\n");
        assert!(text.contains("npm error code E404"), "{text}");
        assert!(
            text.contains("npm error 404 Not Found - GET https://registry.npmjs.org/this-package-does-not-exist-ot"),
            "{text}"
        );
        assert_eq!(t.body.iter().filter(|l| l.as_str() == "npm error 404").count(), 1, "{text}");
        assert_eq!(t.outcome, Outcome::Fail);
        assert_eq!(t.verdict, "[output-trim] install: FAILED");
    }

    #[test]
    fn error_lines_mentioning_audit_or_funding_are_kept() {
        let l = lines(&[
            "Error: audit request failed",
            "Error: funding lookup crashed",
            "run `npm fund` for details",
            "npm audit fix --force",
            "added 3 packages in 2s",
        ]);
        let t = NodeInstall.trim(&l);
        assert!(t.body.iter().any(|b| b == "Error: audit request failed"), "{:#?}", t.body);
        assert!(t.body.iter().any(|b| b == "Error: funding lookup crashed"), "{:#?}", t.body);
        assert!(t.body.iter().all(|b| !b.contains("npm fund") && !b.contains("audit fix")), "{:#?}", t.body);
        assert_eq!(t.outcome, Outcome::Fail);
    }

    #[test]
    fn peer_and_eresolve_lines_are_kept() {
        let l = lines(&[
            "npm warn ERESOLVE overriding peer dependency",
            "npm warn While resolving: a@1.0.0",
            "npm warn Found: react@17.0.2",
            " WARN  Issues with peer dependencies found",
            "added 3 packages in 2s",
        ]);
        let t = NodeInstall.trim(&l);
        assert_eq!(t.body.len(), 5, "{:#?}", t.body);
        assert_eq!(t.outcome, Outcome::Pass);
    }

    #[test]
    fn unexpected_error_line_in_odd_position_is_kept() {
        let l = lines(&[
            "Progress: resolved 10, reused 0, downloaded 0, added 0",
            "added 3 packages in 2s",
            "gyp info it worked if it ends with ok",
            "gyp ERR! build error",
            "Error: EACCES: permission denied, mkdir 'C:\\x'",
            "Done in 2s",
        ]);
        let t = NodeInstall.trim(&l);
        assert!(t.body.iter().any(|b| b == "gyp ERR! build error"), "{:#?}", t.body);
        assert!(t.body.iter().any(|b| b.starts_with("Error: EACCES")), "{:#?}", t.body);
        assert_eq!(t.outcome, Outcome::Fail);
    }

    #[test]
    fn detects_by_content() {
        for case in ["npm_install", "pnpm_install", "npm_err"] {
            assert_eq!(rules::by_content(&fixture("node_install", case)).name(), "node_install", "{case}");
        }
    }

    #[test]
    fn detects_by_command() {
        for cmd in [
            "npm i",
            "npm install",
            "npm install -D vitest",
            "npm ci",
            "pnpm i",
            "pnpm install",
            "pnpm add react",
            "yarn",
            "yarn install",
            "yarn add react",
            "cd x && npm ci | tail",
        ] {
            assert_eq!(rules::by_command(cmd).map(|r| r.name()), Some("node_install"), "{cmd}");
        }
        for cmd in ["yarn test", "npm run build", "npm test", "pnpm run dev"] {
            assert_ne!(rules::by_command(cmd).map(|r| r.name()), Some("node_install"), "{cmd}");
        }
    }

    #[test]
    fn registry_order() {
        let names: Vec<_> = rules::registry().iter().map(|r| r.name()).collect();
        assert_eq!(names, ["dotnet", "cargo", "tsc", "jstest", "node_install", "docker_build", "docker_logs", "generic"]);
    }
}

mod docker {
    use super::*;
    use output_trim::engine::{self, LogTarget};
    use output_trim::rules::docker_build::DockerBuild;
    use output_trim::rules::docker_logs::DockerLogs;
    use output_trim::rules::{self, Outcome, Rule};

    fn lines(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    fn reduction(rule: &dyn Rule, case: &str) -> (usize, usize) {
        let l = fixture("docker", case);
        let dir = tempfile::tempdir().unwrap();
        let out = engine::apply(&l, rule, LogTarget::SaveIn(dir.path()), false);
        (out.kept_chars, out.total_chars)
    }

    #[test]
    fn logs_repetitive_is_reduced_to_a_tenth() {
        let (kept, total) = reduction(&DockerLogs, "logs_repetitive");
        assert!(total >= 1500, "{total}");
        assert!(kept * 100 <= total * 10, "kept {kept} of {total}");
    }

    #[test]
    fn logs_repetitive_keeps_collapse_tail_and_error_with_frames() {
        let l = fixture("docker", "logs_repetitive");
        let t = DockerLogs.trim(&l);
        let text = t.body.join("\n");
        assert!(t.body.iter().any(|b| b.starts_with("(×")), "{text}");
        assert_eq!(t.body.last(), l.last(), "{text}");
        let i = t
            .body
            .iter()
            .position(|b| b.contains("ERROR request failed: connection reset by peer"))
            .unwrap_or_else(|| panic!("{text}"));
        assert_eq!(t.body[i + 1], "  at Server.handle (server.js:88:15)", "{text}");
        assert_eq!(t.body[i + 2], "  at Socket.onData (net.js:412:9)", "{text}");
        assert_eq!(t.body.iter().filter(|b| b.contains("WARN  slow request")).count(), 3, "{text}");
        assert_eq!(t.outcome, Outcome::Unknown);
        assert_eq!(t.verdict, "[output-trim] docker logs: DONE — 2007 lines, 4 warnings/errors");
    }

    #[test]
    fn logs_exception_keeps_message_and_stack() {
        let t = DockerLogs.trim(&fixture("docker", "logs_exception"));
        let text = t.body.join("\n");
        for needle in [
            "Unhandled exception. System.InvalidOperationException: Sequence contains no matching element",
            "at System.Linq.ThrowHelper.ThrowNoMatchException()",
            "OrderProcessor.cs:line 57",
            "OrderProcessor.cs:line 31",
            "---> System.TimeoutException: The operation has timed out.",
            "Repo.cs:line 112",
            "--- End of inner exception stack trace ---",
            "Program.cs:line 14",
            "warn  Retry 1/3 for payment gateway",
        ] {
            assert!(text.contains(needle), "{needle}: {text}");
        }
        assert_eq!(t.outcome, Outcome::Unknown);
    }

    #[test]
    fn logs_exception_is_reduced() {
        let (kept, total) = reduction(&DockerLogs, "logs_exception");
        assert!(total >= 1500, "{total}");
        assert!(kept * 100 <= total * 30,"kept {kept} of {total}");
    }

    #[test]
    fn short_logs_are_kept_verbatim() {
        let l = lines(&["a", "b", "ERROR boom", "  at X.y()"]);
        let t = DockerLogs.trim(&l);
        assert_eq!(t.body, l);
    }

    #[test]
    fn unusual_error_words_above_tail_are_kept() {
        let mut l: Vec<String> = (0..100).map(|i| format!("tick {i} ok-{}", "x".repeat(i % 7))).collect();
        l[10] = "Traceback (most recent call last):".into();
        l.insert(11, "  File \"app.py\", line 3, in <module>".into());
        l.insert(12, "    return 1 / 0".into());
        l.insert(13, "ZeroDivisionError: division by zero".into());
        l.insert(14, "Caused by: disk full".into());
        l[40] = "panic: runtime error: index out of range".into();
        l[41] = "FAILED to start worker".into();
        let t = DockerLogs.trim(&l);
        for needle in [
            "Traceback (most recent call last):",
            "  File \"app.py\", line 3, in <module>",
            "    return 1 / 0",
            "ZeroDivisionError: division by zero",
            "Caused by: disk full",
            "panic: runtime error: index out of range",
            "FAILED to start worker",
        ] {
            assert!(t.body.iter().any(|b| b == needle), "{needle}: {:#?}", t.body);
        }
        assert!(t.body.len() < l.len());
    }

    #[test]
    fn build_fail_keeps_failing_step_and_error() {
        let t = DockerBuild.trim(&fixture("docker", "build_fail"));
        let text = t.body.join("\n");
        assert!(text.contains("[5/5] RUN apk add --no-cache does-not-exist-ot"), "{text}");
        assert!(text.contains("ERROR: unable to select packages:"), "{text}");
        assert!(text.contains("does-not-exist-ot (no such package):"), "{text}");
        assert!(text.contains("failed to solve"), "{text}");
        assert_eq!(t.outcome, Outcome::Fail);
        assert!(t.verdict.starts_with("[output-trim] docker build: FAILED"), "{}", t.verdict);
        // Successful steps and their output are dropped.
        assert!(!text.contains("Installing brotli-libs"), "{text}");
        assert!(!text.contains("building app"), "{text}");
        // The duplicated `------` error block does not repeat the error line.
        assert_eq!(text.matches("ERROR: unable to select packages:").count(), 1, "{text}");
    }

    #[test]
    fn build_fail_is_reduced() {
        let (kept, total) = reduction(&DockerBuild, "build_fail");
        assert!(total >= 1500, "{total}");
        assert!(kept * 100 <= total * 70, "kept {kept} of {total}");
    }

    #[test]
    fn build_success_keeps_image_line() {
        let l = lines(&[
            "#1 [internal] load build definition from Dockerfile",
            "#1 DONE 0.1s",
            "#5 [2/2] RUN echo hi",
            "#5 0.2 hi",
            "#5 DONE 0.3s",
            "#6 exporting to image",
            "#6 writing image sha256:abc123 done",
            "#6 naming to docker.io/library/app:latest done",
            "#6 DONE 0.1s",
        ]);
        let t = DockerBuild.trim(&l);
        assert!(t.body.iter().any(|b| b.contains("naming to docker.io/library/app:latest")), "{:#?}", t.body);
        assert!(t.body.iter().all(|b| !b.ends_with(" hi")), "{:#?}", t.body);
        assert_eq!(t.outcome, Outcome::Pass);
    }

    #[test]
    fn failing_step_output_is_limited_to_last_20_lines() {
        let mut l = lines(&["#7 [3/3] RUN make"]);
        for i in 0..30 {
            l.push(format!("#7 1.{i:03} compiling unit {i}"));
        }
        l.push("#7 ERROR: process \"/bin/sh -c make\" did not complete successfully: exit code: 2".into());
        let t = DockerBuild.trim(&l);
        assert!(t.body.iter().any(|b| b.contains("[3/3] RUN make")));
        assert!(t.body.iter().all(|b| !b.contains("compiling unit 9")), "{:#?}", t.body);
        assert!(t.body.iter().any(|b| b.contains("compiling unit 29")));
        assert_eq!(t.body.iter().filter(|b| b.contains("compiling unit")).count(), 20, "{:#?}", t.body);
    }

    #[test]
    fn unexpected_error_line_in_odd_position_is_kept() {
        let l = lines(&[
            "#1 [internal] load build definition from Dockerfile",
            "#1 DONE 0.1s",
            "#2 [1/2] RUN echo ok",
            "#2 0.2 ok",
            "#2 0.3 fatal error: cannot open file (build continues)",
            "#2 DONE 0.4s",
            "#3 [2/2] COPY . .",
            "#3 DONE 0.1s",
            "failed to read dockerignore: boom",
        ]);
        let t = DockerBuild.trim(&l);
        let text = t.body.join("\n");
        assert!(text.contains("fatal error: cannot open file"), "{text}");
        assert!(text.contains("failed to read dockerignore: boom"), "{text}");
        assert_eq!(t.outcome, Outcome::Fail);
    }

    #[test]
    fn detects_by_content() {
        assert_eq!(rules::by_content(&fixture("docker", "build_fail")).name(), "docker_build");
        assert_ne!(rules::by_content(&fixture("docker", "logs_repetitive")).name(), "docker_build");
    }

    #[test]
    fn detects_by_command() {
        for cmd in ["docker logs api", "docker logs -f --tail 100 api", "docker compose logs api", "docker-compose logs api"] {
            assert_eq!(rules::by_command(cmd).unwrap().name(), "docker_logs", "{cmd}");
        }
        for cmd in [
            "docker build .",
            "docker build --progress=plain -t x .",
            "docker compose build",
            "docker buildx build .",
            "cd svc && docker build .",
        ] {
            assert_eq!(rules::by_command(cmd).unwrap().name(), "docker_build", "{cmd}");
        }
        for cmd in ["docker ps", "docker run alpine", "docker compose up"] {
            assert!(rules::by_command(cmd).is_none(), "{cmd}");
        }
    }

    #[test]
    fn logs_do_not_match_content() {
        assert!(!DockerLogs.matches_content(&fixture("docker", "logs_exception")));
    }
}
