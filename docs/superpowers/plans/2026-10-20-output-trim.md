# output-trim Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Windows-first Claude Code plugin whose Rust binary trims noisy build/test/install/log output to errors, failures and summaries. Claude uses it as a pipe filter (`cmd 2>&1 | output-trim`), and it also runs as a PostToolUse safety net and a SessionStart note.

**Architecture:** One workspace crate `output-trim` (lib + thin bin, no async runtime). Pure modules (`normalize`, `collapse`, `command`, `rules/*`) feed an `engine` that applies a rule, caps the result, saves the full log via `store` and appends the footer. `filter` (stdin mode) and `hook` (PostToolUse / SessionStart JSON) are the two front ends. `main.rs` dispatches on argv.

**Tech Stack:** Rust 1.99 (edition 2024, stable-x86_64-pc-windows-msvc), serde + serde_json, regex. Dev: tempfile. Fixture capture uses the local dotnet 10, cargo, node 24 / npm 12 / pnpm 10, docker 29.

**Spec:** `docs/superpowers/specs/2026-10-20-output-trim-design.md`

**Refinements to the spec (decided here):**
- Overflow line from the engine cap is always `… +N more lines` (one wording, counted in lines). Rules that need item counts (tsc's `+N more in M files`) produce them themselves.
- A `command.rs` module owns command-string parsing (first segment, `cd x &&` skipping, existing-pipe detection). Both rule selection and the hook gates use it.
- Character counts in the footer use `fmt_k`: `n/1000` with one decimal, trailing `.0` removed (`300 → 0.3k`, `50000 → 50k`, `48700 → 48.7k`).

## Global Constraints

- Windows first. The binary must still compile on other targets (no Windows-only APIs needed).
- Dependencies: `serde`, `serde_json`, `regex` only (+ `tempfile` as dev-dependency). No async runtime.
- Verdict line prefix `[output-trim] `. Footer: `[output-trim] kept {fmt_k(kept)} of {fmt_k(total)} chars · full: {path}`; when saving failed: `[output-trim] kept {..} of {..} chars · full log unavailable`.
- Body cap 6,000 characters. Filter pass-through below 1,500 characters. Hook: act only when output > 2,000 characters (or `persistedOutputPath` set) and the result is ≥ 30% smaller.
- Filter input limit 64 MiB (`64 << 20` bytes). Overflow footer suffix: ` · input truncated at 64 MB`.
- Log store: `std::env::temp_dir()/output-trim/YYYYMMDD-HHMMSS-<4 hex>.log`, prune files older than 24 h on each save, errors ignored.
- Hook noisy-command list (first pipeline segment, after skipping `cd <dir> &&`): `dotnet`, `cargo`, `npm`, `pnpm`, `yarn`, `npx`, `tsc`, `vitest`, `jest`, `docker logs`, `docker compose logs`, `docker build`, `docker compose build`.
- Hook skips commands already piping into: `output-trim`, `tail`, `head`, `grep`, `Select-Object`, `Select-String`.
- Hook never fails a session: any error or panic → no stdout, exit 0.
- Filter exit code: 1 when outcome is `Fail`, else 0.
- Session-start note, verbatim (last line only when the exe path is known):
  ```
  output-trim is installed. For build, test, lint, install and log commands, pipe
  through it instead of tail/head: `dotnet test 2>&1 | output-trim`. It keeps every
  error, failed test and summary; the last line gives the path of the full log.
  If `output-trim` is not found (e.g. PowerShell), use: "<absolute exe path>".
  ```
- Marketplace entry description: `Trims noisy build/test/log output to errors, failures and summaries.`
- Allow rule documented in README: `Bash(output-trim *)`.

## Review Focus

1. **Huge single-line output** (minified JS bundle, base64 blob, 5 MB on one line): never echoed whole; the cap truncates by characters, not just lines. Test in Task 4.
2. **Interleaved parallel build output** (MSBuild `-m` prefixes such as `  1>` / `12>`, duplicate errors with different prefixes): dedupe still works. Test in Task 5.
3. **Commands with quotes, `&&` chains and PowerShell pipes** (`cd "C:\My Repo" && dotnet test | Select-Object -Last 20`): gating parses the first real segment and spots the existing pipe. Test in Task 3.
4. **Output that matches several rules' signatures** (`npm test` running vitest after `tsc`): content detection picks deterministically by fixed order, and nothing is lost because unrecognised error lines are kept by the rule's error-line fallback. Test in Task 8.
5. **Empty or whitespace-only input** (filter on a silent command, hook with empty stdout): pass through, no footer, exit 0, no log file. Test in Task 4 and Task 10.

---

## File Structure

```
.claude-plugin/marketplace.json                 + output-trim entry
justfile                                        (existing) `just release output-trim` builds + copies the exe
plugins/output-trim/
  .claude-plugin/plugin.json
  hooks/hooks.json
  bin/output-trim.exe                           built, committed
  README.md
crates/output-trim/
  Cargo.toml
  src/main.rs        argv dispatch → filter::run / hook::post_main / hook::session_start_main
  src/lib.rs         pub mod normalize; collapse; command; rules; engine; store; filter; hook;
  src/normalize.rs   bytes → Vec<String>
  src/collapse.rs    template keys, run collapsing, dedupe
  src/command.rs     command-string parsing
  src/rules/mod.rs   Outcome, Trimmed, Rule, registry, selection
  src/rules/{generic,dotnet,cargo,node_install,tsc,jstest,docker_logs,docker_build}.rs
  src/engine.rs      apply rule → cap → footer
  src/store.rs       save + prune full logs
  src/filter.rs      stdin mode
  src/hook.rs        PostToolUse + SessionStart
  tests/fixtures/<rule>/<case>.txt
  tests/fixtures.rs
  tests/hook_protocol.rs
```

Fixture capture: real tool output is generated in throwaway projects under `%TEMP%\ot-fixtures\` (never committed), then copied into `tests/fixtures/`. Before committing a fixture, replace user-specific absolute paths with `C:\src\…`, and remove hostnames, tokens and emails.

---

### Task 1: Crate scaffold and normalisation

**Files:**
- Create: `crates/output-trim/Cargo.toml`, `src/lib.rs`, `src/main.rs` (stub `fn main() {}`), `src/normalize.rs`

**Interfaces:**
- Produces: `normalize::normalize(bytes: &[u8]) -> Vec<String>`; `normalize::char_len(lines: &[String]) -> usize` (sum of line chars + newlines).

`Cargo.toml`: package `output-trim`, version `0.1.0`, edition 2024, `[lib] name = "output_trim"`, `[[bin]] name = "output-trim"`, deps `serde = { version = "1", features = ["derive"] }`, `serde_json = "1"`, `regex = "1"`, dev-dep `tempfile = "3"`. The workspace already includes `crates/*`.

- [ ] **Step 1: Write failing tests** in `src/normalize.rs` `#[cfg(test)]`:
  - `strips_ansi`: `b"\x1b[31merror\x1b[0m: x\n"` → `["error: x"]`
  - `keeps_text_after_last_cr`: `b"Progress 10%\rProgress 100%\nnext\n"` → `["Progress 100%", "next"]`
  - `crlf_is_newline`: `b"a\r\nb\r\n"` → `["a", "b"]`
  - `collapses_blank_runs`: `b"a\n\n\n\nb\n"` → `["a", "", "b"]`
  - `lossy_invalid_utf8`: `b"caf\xe9\n"` → one line starting with `"caf"`, no panic
  - `trims_trailing_blank_lines`: `b"a\n\n\n"` → `["a"]`
  - `char_len_counts_newlines`: `char_len(&["ab".into(), "c".into()]) == 5`
- [ ] **Step 2: Run** `cargo test -p output-trim normalize`. Expected: compile failure / FAIL.
- [ ] **Step 3: Implement** `normalize` and `char_len`. ANSI regex: `\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07` in a `LazyLock<Regex>`. Order: lossy decode → split on `\n` → strip trailing `\r` → keep text after the last `\r` → strip ANSI → right-trim → collapse blank runs to one → drop leading and trailing blank lines.
- [ ] **Step 4: Run** `cargo test -p output-trim normalize`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(output-trim): crate scaffold and output normalisation`

### Task 2: Collapsing and dedupe helpers

**Files:**
- Create: `crates/output-trim/src/collapse.rs`

**Interfaces:**
- Produces:
  - `template_key(line: &str) -> String`: the line with ISO/syslog timestamps, `0x…`/≥8-char hex ids, GUIDs and digit runs replaced by `#`, whitespace squeezed.
  - `collapse_runs(lines: &[String], min_run: usize) -> Vec<String>`: a run of ≥ `min_run` consecutive lines with an equal `template_key` becomes `(×N similar) <first line>`.
  - `dedupe_keep_order(lines: impl IntoIterator<Item = String>) -> Vec<String>`: drops exact duplicates, keeps first occurrence.

- [ ] **Step 1: Write failing tests:**
  - `template_strips_timestamps_and_numbers`: `template_key("2026-10-20T15:32:12.123Z info req 4512 done in 12ms") == template_key("2026-10-20T15:33:01.004Z info req 4513 done in 9ms")`
  - `template_strips_guid`: lines differing only in a GUID have equal keys
  - `template_distinguishes_words`: `"GET /a 200"` vs `"POST /a 200"` differ
  - `collapses_run`: five template-equal lines with `min_run = 3` → `["(×5 similar) <first>"]`
  - `short_run_kept`: two equal lines with `min_run = 3` are unchanged
  - `dedupe_preserves_order`: `["b","a","b"]` → `["b","a"]`
- [ ] **Step 2: Run** `cargo test -p output-trim collapse`. Expected: FAIL.
- [ ] **Step 3: Implement** the three functions (regexes in `LazyLock`).
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(output-trim): line collapsing and dedupe helpers`

### Task 3: Command parsing, rule types, registry and generic rule

**Files:**
- Create: `src/command.rs`, `src/rules/mod.rs`, `src/rules/generic.rs`

**Interfaces:**
- Produces (`command.rs`):
  - `first_segment(cmd: &str) -> &str`: the first command of the pipeline, with leading `cd <dir> &&` / `cd <dir>;` (any number, quoted dirs allowed) skipped, cut at the first unquoted `|`, `&&`, `||` or `;`, and trimmed.
  - `pipes_into_view(cmd: &str) -> bool`: true when any unquoted `|` segment starts with `output-trim`, `tail`, `head`, `grep`, `Select-Object` or `Select-String` (case-insensitive).
  - `is_noisy(cmd: &str) -> bool`: `first_segment` starts with an entry of the hook noisy-command list (word-boundary match; `npx tsc` counts via `npx`).
- Produces (`rules/mod.rs`):
  ```rust
  #[derive(Clone, Copy, Debug, PartialEq, Eq)]
  pub enum Outcome { Pass, Fail, Unknown }
  pub struct Trimmed { pub verdict: String, pub body: Vec<String>, pub outcome: Outcome }
  pub trait Rule: Sync {
      fn name(&self) -> &'static str;
      fn matches_command(&self, first_segment: &str) -> bool;
      fn matches_content(&self, lines: &[String]) -> bool;
      fn trim(&self, lines: &[String]) -> Trimmed;
  }
  pub fn registry() -> &'static [&'static dyn Rule];      // order: dotnet, cargo, tsc, jstest, node_install, docker_build, docker_logs, generic
  pub fn by_command(cmd: &str) -> Option<&'static dyn Rule>; // uses command::first_segment; never returns generic
  pub fn by_content(lines: &[String]) -> &'static dyn Rule;  // first match in registry order, else generic
  pub fn verdict(label: &str, outcome: Outcome, detail: &str) -> String;
  // "[output-trim] {label}: {PASSED|FAILED|DONE} — {detail}", or without " — {detail}" when detail is empty
  pub fn error_lines(lines: &[String], context: usize) -> Vec<String>; // lines matching (?i)\b(error|warn(ing)?|fail(ed|ure)?|panic(ked)?|exception)\b plus `context` lines after, deduped
  ```
  The registry initially holds only `generic`. Later tasks add their rule at the position given above.
- Generic rule: name `generic`, `matches_command` false, `matches_content` false. `trim` gives body = first 15 lines + `error_lines(lines, 2)` from the middle + last 30 lines, with `collapse_runs(…, 3)` applied, in original order, no line twice. Verdict `verdict("output", Unknown, "")` → `[output-trim] output: DONE`. Outcome `Unknown`.

- [ ] **Step 1: Write failing tests** (`command.rs`):
  - `first_segment("dotnet test") == "dotnet test"`
  - `first_segment(r#"cd "C:\My Repo" && dotnet test | Select-Object -Last 20"#) == "dotnet test"`
  - `first_segment("cd a; cd b && cargo test -- --nocapture") == "cargo test -- --nocapture"`
  - `first_segment(r#"echo "a|b" && x"#) == r#"echo "a|b""#` (quoted pipe ignored)
  - `pipes_into_view("dotnet test 2>&1 | tail -20")` true; `pipes_into_view("docker logs x | Select-Object -Last 5")` true; `pipes_into_view("cargo test 2>&1 | output-trim")` true; `pipes_into_view("cargo test")` false
  - `is_noisy`: true for `npx tsc --noEmit`, `docker compose logs api`, `pnpm install`; false for `git diff`, `docker ps`, `sed -n 1,5p f`, `dotnetfoo`
- [ ] **Step 2: Write failing tests** (`rules/mod.rs`): `by_content` on arbitrary text returns the rule named `generic`; `by_command("git status")` is `None`; `verdict("cargo test", Outcome::Fail, "2 failed")` equals `"[output-trim] cargo test: FAILED — 2 failed"`; `error_lines` keeps `"error: boom"` and the following 2 lines.
- [ ] **Step 3: Write failing tests** (`generic.rs`): 200 numbered lines with `"ERROR db down"` at line 100 → body contains line 1, line 15, `"ERROR db down"`, lines 101–102 and line 200, does not contain line 50, and has no duplicates.
- [ ] **Step 4: Run** `cargo test -p output-trim`. Expected: FAIL.
- [ ] **Step 5: Implement** the three files. Quote-aware splitting: track `"` and `'` state while scanning.
- [ ] **Step 6: Run** `cargo test -p output-trim`. Expected: PASS.
- [ ] **Step 7: Commit** `feat(output-trim): command parsing, rule registry, generic rule`

### Task 4: Engine and log store

**Files:**
- Create: `src/engine.rs`, `src/store.rs`

**Interfaces:**
- Consumes: `normalize::char_len`, `rules::{Rule, Trimmed, Outcome}`.
- Produces (`store.rs`):
  - `default_dir() -> PathBuf` (`temp_dir()/output-trim`)
  - `save(dir: &Path, text: &str) -> io::Result<PathBuf>`: creates the dir, writes `YYYYMMDD-HHMMSS-<4 hex>.log` (local time via `std::time::SystemTime` → UTC is acceptable; hex from nanos), then calls `prune`
  - `prune(dir: &Path, max_age: Duration)`: deletes `*.log` older than `max_age`, ignoring errors
- Produces (`engine.rs`):
  ```rust
  pub const BODY_CAP: usize = 6_000;
  pub const FILTER_PASSTHROUGH: usize = 1_500;
  pub enum LogTarget<'a> { SaveIn(&'a Path), Existing(&'a Path) }
  pub struct Output { pub text: String, pub outcome: Outcome, pub kept_chars: usize, pub total_chars: usize, pub trimmed: bool }
  pub fn apply(lines: &[String], rule: &dyn Rule, log: LogTarget, input_truncated: bool) -> Output;
  pub fn fmt_k(n: usize) -> String;
  ```
  `apply`: empty input → `text` empty, `trimmed` false, `Unknown`. Total < `FILTER_PASSTHROUGH` → original text unchanged, plus the verdict line prepended if the rule is not `generic`, `trimmed` false. Otherwise run `rule.trim`; if it panics (`catch_unwind`), use the generic rule. Body is capped to `BODY_CAP` chars: whole lines while they fit, a single overlong line cut to the remaining budget with `…`, then `… +N more lines`. Then `verdict + body + footer`; `trimmed` is true. Saving: `SaveIn(dir)` saves the full normalised text (footer `full log unavailable` on error); `Existing(p)` references `p`. `input_truncated` appends ` · input truncated at 64 MB` to the footer.

- [ ] **Step 1: Write failing tests** (`store.rs`, using `tempfile::tempdir`): `save` returns an existing path whose content round-trips; `prune` with `Duration::ZERO` deletes a previously saved `.log` and leaves a `.txt` alone.
- [ ] **Step 2: Write failing tests** (`engine.rs`, using a test-only `Rule` impl that returns fixed `Trimmed`):
  - `fmt_k(300) == "0.3k"`, `fmt_k(50_000) == "50k"`, `fmt_k(48_700) == "48.7k"`
  - `empty_input_passes_through`: `apply(&[], …)` gives empty text, `trimmed == false`, and no file in the temp dir
  - `small_input_passes_through`: 10 short lines give the original text, not trimmed
  - `footer_with_saved_path`: 3,000-char input gives text ending in `· full: <path>` with the path existing and holding the full text
  - `footer_existing_path`: `LogTarget::Existing(p)` footer contains `p` and no new file is written
  - `cap_by_lines`: body of 1,000 × 100-char lines gives a text body ≤ 6,000 chars + overflow line `… +N more lines` with the correct N
  - `cap_single_huge_line` (Review Focus 1): one 5,000,000-char line gives total text < 7,000 chars
  - `truncated_note`: `input_truncated = true` gives a footer ending `· input truncated at 64 MB`
  - `panicking_rule_falls_back`: a rule whose `trim` panics still yields `trimmed == true` with the generic verdict
- [ ] **Step 3: Run** `cargo test -p output-trim engine store`. Expected: FAIL.
- [ ] **Step 4: Implement** `store.rs` and `engine.rs`.
- [ ] **Step 5: Run** the tests. Expected: PASS.
- [ ] **Step 6: Commit** `feat(output-trim): trimming engine and full-log store`

### Task 5: dotnet rule

**Files:**
- Create: `src/rules/dotnet.rs`, `tests/fixtures.rs`, `tests/fixtures/dotnet/{build_pass,build_fail,test_pass,test_fail,build_fail_parallel}.txt`
- Modify: `src/rules/mod.rs` (register)

**Interfaces:**
- Consumes: `rules::{Rule, Trimmed, Outcome, verdict, error_lines}`, `collapse::dedupe_keep_order`.
- Produces: `rules::dotnet::Dotnet` (unit struct, `name() == "dotnet"`). `tests/fixtures.rs` helper `fn fixture(rule: &str, case: &str) -> Vec<String>` (reads the file and calls `normalize`), reused by Tasks 6–9.

Behaviour (spec, Rules table): command match is `dotnet` as the first word. Content signatures: `Build succeeded.`, `Build FAILED.`, `Failed!  - Failed:`, `Passed!  - Failed:`, `error CS\d+`, `error NU\d+`, `error MSB\d+`. Keep:
- diagnostics matching `^(?:\s*\d+>)?\s*(?P<file>.+?)\((?P<line>\d+),(?P<col>\d+)\): (?P<sev>error|warning) (?P<code>[A-Z]+\d+): (?P<msg>.+?)(?: \[(?P<proj>.+)\])?$`, rendered `file(line,col): CODE msg [ProjectName]` (project file name only), deduped, errors before warnings, grouped by code in first-seen order
- failed test blocks: `Failed <name> [<time>]` plus following `Error Message:` and `Stack Trace:` lines, keeping stack frames that do not start with `at System.`, `at Microsoft.`, `at Xunit.`, `at NUnit.` or `at Castle.`
- per-assembly summary lines `^(Passed|Failed)!\s+- Failed:` and the `Time Elapsed` line
- `error_lines(…, 0)` for other `error`-matching lines not covered above (e.g. `error NU1101`)

Verdict label: `dotnet test` if a test summary is present, else `dotnet build`. Detail: summed counts `N failed, N passed, N skipped`, or `N errors, N warnings`. Outcome: `Fail` on any error diagnostic, `Build FAILED.` or failed count > 0; `Pass` on `Build succeeded.` or test summaries with 0 failed; else `Unknown`.

- [ ] **Step 1: Capture fixtures.** In `%TEMP%\ot-fixtures\dn`: `dotnet new sln -n Fx`, `dotnet new classlib -n Lib`, `dotnet new xunit -n Lib.Tests`, add both to the sln, reference Lib from Lib.Tests. Write `Lib/Calc.cs` with one method and an unused variable (CS0168 warning), and 3 tests in `Lib.Tests`, all passing. Then run:
  - `dotnet build 2>&1 > build_pass.txt`
  - `dotnet test 2>&1 > test_pass.txt`
  - make one test fail (`Assert.Equal(4, Calc.Add(2, 3))`) and run `dotnet test 2>&1 > test_fail.txt`
  - introduce a type error (`int x = "s";`) and run `dotnet build 2>&1 > build_fail.txt`, then `dotnet build -m -v:n 2>&1 > build_fail_parallel.txt`
  Scrub paths to `C:\src\…` and copy into `tests/fixtures/dotnet/`.
- [ ] **Step 2: Write failing tests** in `tests/fixtures.rs` (`mod dotnet`):
  - `build_fail_keeps_error_once`: the trimmed text contains the CS0029 line exactly once, outcome `Fail`, verdict starts `[output-trim] dotnet build: FAILED — 1 errors`
  - `build_fail_parallel_dedupes` (Review Focus 2): the CS0029 line appears exactly once, with no `\d+>` prefix
  - `test_fail_keeps_failure`: contains the failed test's full name, `Expected: 4`, `Actual:   5`, and a `Calc` / test-file frame. Does not contain `at Xunit.` or `Determining projects`. Outcome `Fail`. Verdict detail `1 failed, 2 passed, 0 skipped`
  - `test_pass_is_short`: outcome `Pass`, trimmed body ≤ 3 lines plus any warning diagnostic lines
  - `build_pass_reduction`: if the fixture is ≥ 1,500 chars, the kept chars ≤ 20% of the original
  - `detects_by_content`: `rules::by_content(&fixture("dotnet","test_fail")).name() == "dotnet"`
- [ ] **Step 3: Run** `cargo test -p output-trim --test fixtures dotnet`. Expected: FAIL.
- [ ] **Step 4: Implement** `Dotnet` and register it first in `registry()`.
- [ ] **Step 5: Run** `cargo test -p output-trim`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(output-trim): dotnet build/test rule with fixtures`

### Task 6: cargo rule

**Files:**
- Create: `src/rules/cargo.rs`, `tests/fixtures/cargo/{build_warn,build_fail,test_pass,test_fail,clippy_warn}.txt`
- Modify: `src/rules/mod.rs`, `tests/fixtures.rs` (`mod cargo`)

**Interfaces:** Produces `rules::cargo::Cargo` (`name() == "cargo"`).

Behaviour: command `cargo` as first word. Content: `^\s*Compiling \S+ v`, `^test result:`, `^error\[E\d+\]`, `^warning: `. Keep each diagnostic block, from a line starting `error`/`warning` (but not `warning: \`x\` (lib) generated N warnings` summary lines, which are kept as-is) through the following indented `-->`, `|`, `=` and blank-separated note lines up to the next non-indented line. Keep `---- <name> stdout ----` sections up to the next `----` or `failures:` line, the `failures:` name list, and all `test result:` lines. Drop `Compiling|Checking|Finished|Running|Doc-tests|Fresh|Blocking` lines and `test .* \.\.\. ok`. Label `cargo test` when `test result:` is present, else `cargo build`. Detail: `N failed, N passed` summed from `test result:` lines, or `N errors, N warnings`. Outcome `Fail` on `error[`/`error:` diagnostics or failed > 0.

- [ ] **Step 1: Capture fixtures.** `cargo new --lib %TEMP%\ot-fixtures\cr`. Add 30 passing tests generated in a loop plus one unused variable. Run `cargo build 2>&1 > build_warn.txt` (do a `cargo clean` first so `Compiling` lines appear), `cargo test 2>&1 > test_pass.txt`, then add a failing `assert_eq!(1 + 1, 3)` test and run `cargo test 2>&1 > test_fail.txt`. Add a type error and run `cargo build 2>&1 > build_fail.txt`. Then `cargo clippy 2>&1 > clippy_warn.txt` on the warning version.
- [ ] **Step 2: Write failing tests:** `test_fail` keeps the failing test name, `assertion \`left == right\` failed`, `left: 2`, `right: 3`, and `test result: FAILED. 30 passed; 1 failed`; drops `... ok` lines; outcome `Fail`; kept ≤ 20% of the original. `build_fail` keeps `error[E0308]` with its `-->` location and code-frame lines. `build_warn` gives outcome `Pass` with the unused-variable warning block kept and no `Compiling` lines. `clippy_warn` keeps the clippy lint name. Content detection picks `cargo`.
- [ ] **Step 3: Run** `cargo test -p output-trim --test fixtures cargo`. Expected: FAIL.
- [ ] **Step 4: Implement** and register after `dotnet`.
- [ ] **Step 5: Run** `cargo test -p output-trim`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(output-trim): cargo rule with fixtures`

### Task 7: tsc rule

**Files:**
- Create: `src/rules/tsc.rs`, `tests/fixtures/tsc/{errors_few,errors_many}.txt`
- Modify: `src/rules/mod.rs`, `tests/fixtures.rs` (`mod tsc`)

**Interfaces:** Produces `rules::tsc::Tsc` (`name() == "tsc"`).

Behaviour: command `tsc`, or `npx tsc` / `pnpm tsc` / `pnpm exec tsc`. Content `error TS\d+:`. Parse both `file(line,col): error TSnnnn: msg` and `file:line:col - error TSnnnn: msg`. Render `file:line TSnnnn msg`, grouped under a `file` header line in first-seen order, with code frames dropped. Over 30 errors: the first 30, then `+N more in M files`, then `by code: TS2345×40, TS2322×12, …` (descending). Verdict `tsc: FAILED — N errors in M files`; with no errors, `tsc: PASSED`.

- [ ] **Step 1: Capture fixtures.** In `%TEMP%\ot-fixtures\ts`: `npm init -y`, `npm i -D typescript`. Write 3 `.ts` files with 4 type errors total and run `npx tsc --noEmit --pretty 2>&1 > errors_few.txt`. Then generate one file with 80 `const xN: number = "s";` lines across 5 files and run `npx tsc --noEmit 2>&1 > errors_many.txt`.
- [ ] **Step 2: Write failing tests:** `errors_few` keeps all 4 `TSnnnn` codes with their file:line, has no `~~~` lines, and outcome `Fail`. `errors_many` has exactly 30 error lines, a `+50 more in` line, and a `by code: TS2322×80` line. Content detection picks `tsc`.
- [ ] **Step 3: Run** `cargo test -p output-trim --test fixtures tsc`. Expected: FAIL.
- [ ] **Step 4: Implement** and register after `cargo`.
- [ ] **Step 5: Run** `cargo test -p output-trim`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(output-trim): tsc rule with fixtures`

### Task 8: jstest and node_install rules

**Files:**
- Create: `src/rules/jstest.rs`, `src/rules/node_install.rs`, `tests/fixtures/jstest/{vitest_pass,vitest_fail,npm_test_tsc_then_vitest}.txt`, `tests/fixtures/node_install/{npm_install,pnpm_install,npm_err}.txt`
- Modify: `src/rules/mod.rs`, `tests/fixtures.rs` (`mod jstest`, `mod node_install`)

**Interfaces:** Produces `rules::jstest::JsTest` (`"jstest"`) and `rules::node_install::NodeInstall` (`"node_install"`).

jstest: command `vitest`, `jest`, `npx vitest|jest`, `npm test`, `npm run test`, `pnpm test`, `pnpm run test`, `yarn test`. Content: `^\s*Test Files\s+\d+`, `^Tests:\s+\d+`. Keep `FAIL`/`×`/`✗`/`●` failing-test header lines, the following assertion block (`AssertionError`, `Expected`, `Received`, `- Expected`, `+ Received`, diff lines) up to the next blank-blank or next failure header, the first stack line outside `node_modules`, and the summary lines (`Test Files`, `Tests`, `Duration`, jest `Tests:`/`Test Suites:`). Also `error_lines(…, 0)` for lines not covered (Review Focus 4: a `tsc` error before vitest output stays). Verdict `tests: FAILED — N failed, N passed`.

node_install: command `npm i`, `npm install`, `npm ci`, `pnpm i`, `pnpm install`, `pnpm add`, `yarn`, `yarn install`, `yarn add`. Content: `added \d+ packages`, `npm ERR!`, `npm error`, `ERR_PNPM_`, `Progress: resolved`, `Packages: \+\d+`. Keep the summary lines (`added N packages…`, `Packages: +N`, `Done in`), `ERR!`/`npm error`/`ERR_PNPM_` blocks, and peer-dependency lines (`peer`, `ERESOLVE`). Deprecations (`npm warn deprecated <pkg>` / `WARN deprecated`) collapse into `N deprecation warnings (pkg1, pkg2, …)` (first 8 names). Drop `Progress:`, `funding`, `npm fund`, `audit` nag lines. Verdict `install: PASSED — added N packages` / `FAILED`.

Registry order after this task: dotnet, cargo, tsc, jstest, node_install, generic.

- [ ] **Step 1: Capture fixtures.** In `%TEMP%\ot-fixtures\js`: `npm init -y`, `npm i -D vitest typescript 2>&1 > npm_install.txt`. Write 12 passing tests and run `npx vitest run 2>&1 > vitest_pass.txt`. Add 2 failing `expect(1).toBe(2)` tests and run `npx vitest run 2>&1 > vitest_fail.txt`. Set `"test": "tsc --noEmit && vitest run"` with one type error and capture `npm test 2>&1 > npm_test_tsc_then_vitest.txt` (fix the type error in a second variant if tsc short-circuits, so both outputs appear; otherwise use `tsc --noEmit; vitest run`). Copy the project, `pnpm install 2>&1 > pnpm_install.txt`. Then `npm i this-package-does-not-exist-ot 2>&1 > npm_err.txt`.
- [ ] **Step 2: Write failing tests:** `vitest_fail` keeps both failing test names and `expected 1 to be 2`, drops the passing `✓` lines, outcome `Fail`, verdict `2 failed, 12 passed`. `vitest_pass` gives `Pass` with a short body. `npm_test_tsc_then_vitest` keeps the `error TS` line (Review Focus 4). `npm_install` keeps `added N packages`, has no `Progress:`/`fund` lines, outcome `Pass`. `pnpm_install` keeps `Packages: +N` / `Done in`. `npm_err` keeps the `404`/`E404` error line, outcome `Fail`. Content detection works for each.
- [ ] **Step 3: Run** `cargo test -p output-trim --test fixtures jstest node_install`. Expected: FAIL.
- [ ] **Step 4: Implement** both and register them.
- [ ] **Step 5: Run** `cargo test -p output-trim`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(output-trim): vitest/jest and npm/pnpm install rules`

### Task 9: docker rules

**Files:**
- Create: `src/rules/docker_logs.rs`, `src/rules/docker_build.rs`, `tests/fixtures/docker/{logs_repetitive,logs_exception,build_fail}.txt`
- Modify: `src/rules/mod.rs`, `tests/fixtures.rs` (`mod docker`)

**Interfaces:** Produces `rules::docker_logs::DockerLogs` (`"docker_logs"`, command only, `matches_content` false) and `rules::docker_build::DockerBuild` (`"docker_build"`).

docker_logs: command `docker logs`, `docker compose logs`, `docker-compose logs`. The last 40 lines are kept verbatim. Above them, keep lines matching `(?i)\b(warn|warning|error|err|fatal|exception|panic|crit|critical)\b` plus following stack-trace lines (lines starting with whitespace + `at `, `---`, `File "`, or `Caused by`). Everything above the tail goes through `collapse_runs(…, 3)` first, so repetitive non-error lines become `(×N similar) …`, and the kept error lines are then selected from that collapsed list. Verdict `docker logs: DONE — N lines, M warnings/errors`. Outcome is always `Unknown` (logs are not pass/fail).

docker_build: command `docker build`, `docker compose build`, `docker buildx build`. Content `^#\d+ \[`. Keep `#N [stage x/y] RUN …` step headers only for the failing step, `ERROR:`/`error:` lines and the failing step's last 20 output lines, `failed to solve`, and the final `naming to` / `writing image` line. Outcome `Fail` on `ERROR` / `failed to solve`.

Registry order final: dotnet, cargo, tsc, jstest, node_install, docker_build, docker_logs, generic.

- [ ] **Step 1: Capture fixtures.** For `logs_repetitive`, pick a running container (`docker ps`) and run `docker logs --tail 3000 <name> 2>&1 > logs_repetitive.txt`. Scrub hostnames, IPs, tokens and emails. If no container is noisy, run `docker run --name ot-noise alpine sh -c 'for i in $(seq 1 2000); do echo "$(date -Iseconds) info request $i handled in $((i%17))ms"; done; echo "ERROR something failed"; echo "  at Foo.Bar()"'`. Build `logs_exception` from a .NET or Node container that logged an exception, or synthesise one the same way with a multi-line stack. `build_fail`: a Dockerfile `FROM alpine` + `RUN apk add does-not-exist-ot`, then `docker build --progress=plain . 2>&1 > build_fail.txt`.
- [ ] **Step 2: Write failing tests:** `logs_repetitive` output is ≤ 10% of the original and has a `(×` collapse line, the last fixture line, and the `ERROR` line with its `at` frame. `logs_exception` keeps the exception message and its stack lines. `build_fail` keeps the `apk add does-not-exist-ot` step and the `ERROR`/`failed to solve` line, with outcome `Fail`. `rules::by_command("docker compose logs api").unwrap().name() == "docker_logs"`.
- [ ] **Step 3: Run** `cargo test -p output-trim --test fixtures docker`. Expected: FAIL.
- [ ] **Step 4: Implement** both and register them.
- [ ] **Step 5: Run** `cargo test -p output-trim`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(output-trim): docker logs and docker build rules`

### Task 10: Filter mode and binary entry point

**Files:**
- Create: `src/filter.rs`
- Modify: `src/main.rs`, `src/lib.rs`
- Test: `tests/hook_protocol.rs` (filter section, runs the built binary via `env!("CARGO_BIN_EXE_output-trim")`)

**Interfaces:**
- Consumes: `normalize`, `rules::by_content`, `engine::{apply, LogTarget}`, `store::default_dir`.
- Produces: `filter::run(input: &mut dyn Read, out: &mut dyn Write, store_dir: &Path) -> i32` (exit code). `main.rs` dispatch: no args → `filter::run(stdin, stdout, default_dir())`; `hook post` → `hook::post_main()`; `hook session-start` → `hook::session_start_main()` (stub both to exit 0 until Task 11); anything else → filter mode, ignoring args. `main` calls `std::process::exit(code)`.

`filter::run`: read up to `64 << 20` bytes and note whether more remained (drain and discard the rest so the producer doesn't block on a full pipe). Then `normalize`, `by_content`, and `apply(… LogTarget::SaveIn(store_dir), truncated)`. Write `text` with a trailing newline (nothing for empty input). Return 1 if outcome is `Fail`, else 0. Wrap the body in `catch_unwind`. On panic, write the raw input lossily and return 0.

- [ ] **Step 1: Write failing tests** (`tests/hook_protocol.rs`, `mod filter`), each spawning the binary with stdin from a fixture (logs go to the real `default_dir()`):
  - `filter_dotnet_fail_exit_1`: stdin `tests/fixtures/dotnet/test_fail.txt` gives exit code 1, stdout starting `[output-trim] dotnet test: FAILED` and ending with a `full: ` path that exists
  - `filter_cargo_pass_exit_0`: `cargo/test_pass.txt` gives exit 0
  - `filter_empty` (Review Focus 5): empty stdin gives exit 0 and empty stdout
  - `filter_small_passthrough`: `"hello\n"` gives stdout `"hello\n"`
  - `filter_ignores_args`: `output-trim --whatever` with a small input behaves as passthrough
- [ ] **Step 2: Run** `cargo test -p output-trim --test hook_protocol filter`. Expected: FAIL.
- [ ] **Step 3: Implement** `filter.rs` and `main.rs` dispatch.
- [ ] **Step 4: Run** `cargo test -p output-trim`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(output-trim): stdin filter mode and binary dispatch`

### Task 11: Hook mode (PostToolUse and SessionStart)

**Files:**
- Create: `src/hook.rs`
- Modify: `src/main.rs`
- Test: `tests/hook_protocol.rs` (`mod post`, `mod session_start`)

**Interfaces:**
- Consumes: `command::{is_noisy, pipes_into_view}`, `rules::by_command`, `normalize`, `engine`, `store`.
- Produces:
  - `hook::post(input: &str, store_dir: &Path) -> Option<String>`: the JSON to print, or `None` for silence
  - `hook::session_start(exe: Option<&Path>) -> String`: JSON with `hookSpecificOutput.hookEventName = "SessionStart"` and `additionalContext` = the verbatim note from Global Constraints
  - `post_main()` / `session_start_main()`: read all stdin, call the above inside `catch_unwind`, print, and always exit 0. `session_start_main` passes `std::env::current_exe().ok()`.

`post` input (serde, unknown fields ignored): `tool_name`, `tool_input.command`, and `tool_response.{stdout, stderr, interrupted, isImage, persistedOutputPath?}`. Gates in spec order: (1) `tool_name == "Bash"`, not interrupted, not image; (2) `is_noisy(cmd)`; (3) `!pipes_into_view(cmd)`; (4) `stdout.len() + stderr.len() > 2000` or `persistedOutputPath` is set. The text comes from the `persistedOutputPath` file if set and readable (else `None`), otherwise `stdout` + (`"\n"` + `stderr` if non-empty). Rule: `by_command(cmd)`, which is never generic. `apply` with `LogTarget::Existing(p)` if persisted, else `SaveIn(store_dir)`. If saving failed (footer contains `full log unavailable`), return `None`. (5) If `kept_chars * 10 > total_chars * 7`, return `None`. Output JSON:
```json
{"hookSpecificOutput":{"hookEventName":"PostToolUse","updatedToolOutput":{"stdout":"<text>","stderr":"","interrupted":false,"isImage":false}}}
```

- [ ] **Step 1: Write failing unit tests** (`hook.rs`), with inputs built by a helper `fn input(cmd: &str, stdout: &str, persisted: Option<&Path>) -> String` that mirrors the probe-captured shape (`session_id`, `hook_event_name`, `tool_name`, `tool_input{command,description}`, `tool_response{stdout,stderr,interrupted,isImage,noOutputExpected}`, `tool_use_id`):
  - `trims_docker_logs`: `docker logs api` with the `logs_repetitive` fixture gives `Some(json)`, whose `updatedToolOutput.stdout` starts `[output-trim] docker logs` and is shorter than 30% of the input
  - `uses_persisted_file`: stdout cut to 30,000 chars plus `persistedOutputPath` pointing to the full fixture gives a footer containing that path, and no new file in `store_dir`
  - `silent_for_git_diff`: `git diff` with a large stdout gives `None`
  - `silent_when_already_piped`: `dotnet test | tail -20` gives `None`
  - `silent_when_small`: `dotnet build` with 500 chars gives `None`
  - `silent_when_not_worth_it`: noisy command whose output is all error lines (reduction < 30%) gives `None`
  - `silent_on_bad_json`: `"{not json"` gives `None`
  - `silent_on_interrupted`, `silent_on_missing_persisted_file`
  - `session_start_note_verbatim`: `session_start(Some(Path::new(r"C:\p\output-trim.exe")))` gives `additionalContext` equal to the Global Constraints note with that path; with `None`, the last line is absent
- [ ] **Step 2: Write failing binary tests** (`tests/hook_protocol.rs`): `output-trim hook post` with the `trims_docker_logs` input on stdin gives exit 0 and stdout that parses as JSON. With `"{not json"` it gives exit 0 and empty stdout. `output-trim hook session-start` gives exit 0 and JSON whose `additionalContext` contains `| output-trim`. `noop_hook_is_fast` (release-only, `#[cfg_attr(debug_assertions, ignore)]`): 20 runs of `hook post` with a `git status` input average < 20 ms.
- [ ] **Step 3: Run** `cargo test -p output-trim`. Expected: FAIL.
- [ ] **Step 4: Implement** `hook.rs` and wire up `main.rs`.
- [ ] **Step 5: Run** `cargo test -p output-trim` and `cargo test -p output-trim --release noop_hook_is_fast`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(output-trim): PostToolUse and SessionStart hook modes`

### Task 12: Plugin packaging and release

**Files:**
- Create: `plugins/output-trim/.claude-plugin/plugin.json` (`name` `output-trim`, `version` `0.1.0`, `description` = the marketplace description), `plugins/output-trim/hooks/hooks.json` (exactly as in the spec's Entry points section), `plugins/output-trim/README.md`
- Modify: `.claude-plugin/marketplace.json` (add the entry from the spec's Distribution section)
- Create (built): `plugins/output-trim/bin/output-trim.exe`

README contents: what it does (the before/after example from the spec), the one-time allow rule `Bash(output-trim *)` with how to add it (`/permissions` or `permissions.allow` in `~/.claude/settings.json`), why it is safe (reads stdin only, never executes anything), that the full log path is in the footer, and the limitation that unpiped failing commands are not trimmed.

No build-script change is needed: the root `justfile` recipes are generic, because the crate name equals the plugin folder name. Do not run `just publish` (it commits, tags and pushes; that is the user's call). Commit locally only.

- [ ] **Step 1: Write the files** above.
- [ ] **Step 2: Run** `just test`, then `just release output-trim`. Expected: tests pass; `Released output-trim.exe` printed; `plugins/output-trim/bin/output-trim.exe` exists.
- [ ] **Step 3: Smoke-test the shipped exe:** `Get-Content crates/output-trim/tests/fixtures/cargo/test_fail.txt | plugins/output-trim/bin/output-trim.exe; $LASTEXITCODE`. Expected: a trimmed cargo verdict, then `1`.
- [ ] **Step 4: Validate JSON:** `Get-Content plugins/output-trim/hooks/hooks.json | ConvertFrom-Json` and the same for `.claude-plugin/marketplace.json`. Expected: no error.
- [ ] **Step 5: Commit** `feat(output-trim): plugin packaging and hooks` (only these files and the exe)

### Task 13: End-to-end verification (manual)

**Files:**
- Modify: `docs/superpowers/specs/2026-10-20-output-trim-design.md`. Append a `**Verified (date, Claude Code version):**` note under Hook capabilities and Testing, recording the results below. This is the only change.

- [ ] **Step 1: Headless session with the plugin.** Create a scratch cargo project with one failing test. Run `claude -p --plugin-dir <repo>/plugins/output-trim --allowedTools "Bash(cargo *),Bash(output-trim *),Bash(docker logs *)" "Run the tests in this project and tell me what failed. Then show me the last logs of container <name>."` Expected: the transcript shows Claude ran `cargo test 2>&1 | output-trim` (the session-start note took effect), the tool result starts with `[output-trim] cargo test: FAILED`, and the unpiped `docker logs` result starts with `[output-trim] docker logs` (post hook).
- [ ] **Step 2: PowerShell tool PATH.** Ask a headless session to run `Get-Content <fixture> | output-trim` with the PowerShell tool. Record whether the bare name resolves or the absolute-path fallback from the note was needed.
- [ ] **Step 3: Allow-rule check.** Run the same session without `Bash(output-trim *)` in `--allowedTools` and confirm the piped command asks for approval (documents why the README rule matters).
- [ ] **Step 4: Record results** in the spec and commit `docs(output-trim): record end-to-end verification`.
