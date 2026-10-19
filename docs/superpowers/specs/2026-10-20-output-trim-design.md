# output-trim — Design

Date: 2026-10-20
Status: Draft for review

## Context

This repo is a Claude Code plugin marketplace for plugins that make Claude faster
and cheaper in tokens. `everything-find` (fast file lookup) is done; `code-outline`
is a separate effort. This spec covers the third plugin, **output-trim**: shrinking
noisy Bash output (builds, tests, installs, container logs) before it reaches
Claude's context, while keeping errors, failures and summaries.

Like the other plugins it is written in Rust, lives in the shared Cargo workspace,
ships a committed prebuilt Windows exe, and targets Windows first.

## Problem, from real usage

A scan of 196 local Claude Code transcripts (2026-10-20) showed:

- Claude already self-trims build/test output by piping it through `tail`/`grep`/
  `Select-Object`: 484 of 485 `dotnet test` calls and 247 of 248 `dotnet build`
  calls were piped; results average under 1k characters.
- The real cost of that habit is **blind truncation**: `| tail -20` can cut off the
  actual error, and Claude then re-runs the whole build or test suite.
- The largest compressible outputs that are not deliberate reads are `docker logs`
  (avg 4.2k chars, highly repetitive) and `tsc` (avg 6.1k chars, many same-shaped
  errors).
- Deliberate reads (`sed -n`, `grep -n`, `cat`, `git diff`, `git log`) dominate total
  volume but are content Claude asked for. They must not be trimmed.

Stacks in use: .NET (studio-e, many solutions), Node with npm and pnpm, Docker,
Rust; occasional Go and Python.

## Hook capabilities (verified 2026-10-20, Claude Code 2.1.301, Windows)

Established by headless probes with throwaway hooks plus the official docs:

1. `PostToolUse` (matcher `Bash`) fires **only when the command exits 0**. Returning
   `hookSpecificOutput.updatedToolOutput` with `{stdout, stderr, interrupted, isImage}`
   replaces what Claude sees.
2. Its `tool_response` has `stdout, stderr, interrupted, isImage, noOutputExpected`.
   When output exceeds 30,000 characters, `stdout` is cut to 30,000 and
   `persistedOutputPath` (full output file) plus `persistedOutputSize` are added.
   There is no exit-code field.
3. Non-zero exits go to `PostToolUseFailure` only. Its input has an `error` string
   (`Exit code N\n…`, already head+tail capped at about 10k chars). An
   `updatedToolOutput` returned there is **ignored**. Failing commands cannot be
   trimmed after the fact.
4. `PreToolUse` `updatedInput` rewrites the command, but permission rules are then
   evaluated against the rewritten command. A leading wrapper breaks the user's
   allow rules; `set -o pipefail`, `{ …; }` grouping and similar forms trigger
   approval. Only `cmd 2>&1 | f` keeps the user's rule for `cmd` working, and it
   loses `cmd`'s exit code. **Decision: no command rewriting.**
5. Files in a plugin's `bin/` are on the Bash tool's `PATH` while the plugin is
   enabled. PATH for the PowerShell tool is not documented.
6. Plugins cannot contribute permission rules. Pipelines are checked per segment,
   so `cmd 2>&1 | output-trim` needs the user's rule for `cmd` plus one rule for
   `output-trim`.

## Goal

Replace Claude's blind `| tail` with a smart filter that keeps every error, failed
test and summary, and catch large, noisy successful output that Claude did not pipe.

### Success criteria

- On the fixtures, a failing `dotnet test` or `cargo test` keeps 100% of failed test
  names and error messages, and output shrinks by at least 80%.
- The post hook adds under 20 ms to a Bash call when it does nothing.
- Output of file reads and git commands is never changed.
- When anything is dropped, the full output is one path away.

### Non-goals (v1)

- Trimming failing commands that were not piped (Claude Code does not allow it).
- Rewriting Claude's commands.
- User-configurable rules.
- Git output, file reads.
- Linux/macOS builds.

## What it does

Claude runs `dotnet test 2>&1 | output-trim` instead of `dotnet test | tail -20`.
`output-trim` reads all of the output and prints a verdict, the details that explain
failures and warnings, and a footer with the path of the saved full log:

```
[output-trim] dotnet test: FAILED — 1 failed, 411 passed, 2 skipped
Failed Studio.Api.Tests.AuthTests.Login_Expired
  Expected 401 but was 200
  at AuthTests.cs:line 42
[output-trim] kept 0.3k of 50k chars · full: C:\Users\…\Temp\output-trim\20261020-153212-ab12.log
```

A session-start note tells Claude the tool exists. A post hook shrinks large
successful output from known noisy commands that Claude did not pipe.

## Architecture

### Repo layout

```
crates/output-trim/
  Cargo.toml
  src/
    main.rs          arg dispatch: filter (default) | hook post | hook session-start
    lib.rs
    normalize.rs     bytes → clean lines
    engine.rs        rule selection, size cap, threshold, footer
    rules/
      mod.rs         Rule trait, registry, command + content detection
      dotnet.rs  cargo.rs  node_install.rs  tsc.rs  jstest.rs
      docker_logs.rs  docker_build.rs  generic.rs
    collapse.rs      repeated-line / template collapsing (shared by rules)
    store.rs         save full log, prune old logs
    hook.rs          hook JSON in/out (post, session-start)
  tests/
    fixtures/<rule>/<case>.txt
    fixtures.rs      rule tests against real captured output
    hook_protocol.rs runs the built binary with hook JSON on stdin
plugins/output-trim/
  .claude-plugin/plugin.json
  hooks/hooks.json
  bin/output-trim.exe          committed prebuilt binary
  README.md                    what it does + the one allow rule to add
```

`scripts/release.ps1` is extended to build and copy both crates' exes.
`.claude-plugin/marketplace.json` gains an `output-trim` entry.

Dependencies stay minimal for fast start-up: `serde`, `serde_json`, `regex`.
No async runtime.

### Entry points

| Mode | Invocation | Input | Behaviour |
|---|---|---|---|
| Filter | `output-trim` (no args) | raw output on stdin; command unknown | Detects the rule from content, always applies it. Claude opted in by piping. |
| Post hook | `output-trim hook post` | PostToolUse JSON on stdin | Acts only if every gate below passes; otherwise prints nothing. |
| Session start | `output-trim hook session-start` | SessionStart JSON on stdin | Prints the guidance note. |

`hooks/hooks.json`:

```json
{
  "hooks": {
    "SessionStart": [
      { "matcher": "startup|resume|clear|compact",
        "hooks": [{ "type": "command", "command": "\"${CLAUDE_PLUGIN_ROOT}/bin/output-trim.exe\" hook session-start" }] }
    ],
    "PostToolUse": [
      { "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "\"${CLAUDE_PLUGIN_ROOT}/bin/output-trim.exe\" hook post", "timeout": 10 }] }
    ]
  }
}
```

### Post-hook gates

Trim only when all of these hold:

1. `tool_name` is `Bash`, and `interrupted` and `isImage` are false.
2. The command's first pipeline segment starts with a known noisy command:
   `dotnet`, `cargo`, `npm`, `pnpm`, `yarn`, `npx`, `tsc`, `vitest`, `jest`,
   `docker logs`, `docker compose logs`, `docker build`, `docker compose build`.
   A leading `cd <dir> &&` is skipped before matching.
3. The command does not already pipe into `output-trim`, `tail`, `head`, `grep`,
   `Select-Object` or `Select-String` (Claude already chose a view).
4. Combined stdout+stderr exceeds 2,000 characters, or `persistedOutputPath` is set.
5. The trimmed result is at least 30% smaller than the original.

Full text source: `persistedOutputPath` when present (the inline `stdout` is cut to
30k), else `stdout` + `stderr`. Output: `updatedToolOutput` with the trimmed text in
`stdout`, empty `stderr`, and `interrupted`/`isImage` copied from the input.

### Session-start note

Printed as `hookSpecificOutput.additionalContext`, about 4 lines:

```
output-trim is installed. For build, test, lint, install and log commands, pipe
through it instead of tail/head: `dotnet test 2>&1 | output-trim`. It keeps every
error, failed test and summary; the last line gives the path of the full log.
If `output-trim` is not found (e.g. PowerShell), use: "<absolute exe path>".
```

The absolute path comes from the exe's own location (`std::env::current_exe`).

### Engine flow

1. **Normalise** (`normalize.rs`): decode with lossy UTF-8, strip ANSI escape
   sequences, keep only the text after the last `\r` in each line (progress
   redraws), normalise `\r\n`, collapse runs of blank lines.
2. **Select rule** (`rules/mod.rs`): by command when known (hook mode), otherwise by
   content signature. Signatures are checked in a fixed order; the first match wins.
   `generic` is the fallback.
3. **Apply rule.** It returns `Trimmed { verdict: String, body: Vec<String>, outcome:
   Pass | Fail | Unknown }`.
4. **Cap**: the body is limited to about 6,000 characters. Overflow is replaced by
   `… +N more <items>` (the rule names the item: errors, tests, lines).
5. **Store**: if anything was dropped, save the normalised full text and append the
   footer. Hook mode with `persistedOutputPath` references that file instead.
6. **Threshold**: in hook mode, gate 5 applies. In filter mode, input under 1,500
   characters passes through unchanged (verdict line still added when a rule
   recognised the tool).

### Rule trait

```rust
pub trait Rule {
    fn name(&self) -> &'static str;
    fn matches_command(&self, cmd: &str) -> bool;
    fn matches_content(&self, lines: &[String]) -> bool;
    fn trim(&self, lines: &[String]) -> Trimmed;
}
```

Each rule is a pure function of the normalised lines, so it is tested without
processes or files.

## Rules

Every rule outputs a one-line verdict, then only the lines that explain failures or
warnings, then (via the engine) the footer. A passing run is usually the verdict
alone, plus warnings.

| Rule | Detected by | Keeps | Drops |
|---|---|---|---|
| `dotnet` (build/test/restore) | cmd `dotnet`; content `Build succeeded.`, `Build FAILED.`, `Failed!  - Failed:`, `Passed!  - Failed:`, `error CS`, `error NU` | Errors and warnings deduped (MSBuild prints each twice) and grouped by code: `file(line,col): CS0168 message [project]`. Per failed test: name, error message, stack frames outside `System.`/`Microsoft.`/`Xunit.`/`NUnit.` namespaces. Final counts and duration per test project. | Restore and up-to-date lines, `X -> path.dll`, passing tests, logger banners, `Determining projects…` |
| `cargo` (build/test/clippy/check) | cmd `cargo`; content `Compiling `, `test result:`, `error[E`, `warning: unused` | Each `error`/`warning` block in full (message, code frame, notes). Failing test names with their `---- name stdout ----` panic section. All `test result:` lines. | `Compiling`/`Checking`/`Finished`/`Running` lines, `test x ... ok` lines |
| `node_install` (npm/pnpm/yarn install, ci, add) | cmd `npm i(nstall)`/`npm ci`/`pnpm i(nstall)`/`pnpm add`/`yarn`/`yarn add`; content `added \d+ packages`, `npm ERR!`, `Progress: resolved` | Final summary, `ERR!`/`ERR_PNPM_` blocks, peer-dependency conflicts. Deprecations collapse to `N deprecation warnings (pkg1, pkg2, …)`. | Progress, funding/audit nags |
| `tsc` | cmd `tsc` or `npx tsc`; content `error TS\d+` | Errors as `file:line TS2345 message`, grouped by file. Over 30 errors: first 30, then `+N more in M files` and a per-code count. | Repeated code-frame snippets |
| `jstest` (vitest/jest, also via `npm test`/`pnpm test`) | cmd `vitest`, `jest`; content `Test Files `, `Tests: ` | Failing test names, assertion diff, first stack frame outside `node_modules`, summary block | Passing test lines, progress |
| `docker_logs` | cmd `docker logs`, `docker compose logs` (filter mode: no content signature; falls to `generic`) | Last 40 lines verbatim. Above them: warning/error/exception lines with following stack-trace lines; runs of lines identical after stripping timestamps, hex ids and numbers collapse to `(×N similar) <first line>` | Repetition |
| `docker_build` | cmd `docker build`, `docker compose build`; content `#\d+ \[` | Failing step and its error, final `naming to`/image line | Layer download/extract progress |
| `generic` | fallback (filter mode only; never selected in hook mode) | Lines matching `error|warn|fail|panic|exception` (case-insensitive) with 2 lines of context, repeated-line collapse, first 15 and last 30 lines | The rest |

Outcome rules: `Fail` only when a rule sees a definite failure marker (failed-test
count > 0, `error CS`/`error[E`/`error TS`, `npm ERR!`, `ERR_PNPM_`, `Build FAILED.`,
a failed docker build step). `Pass` when it sees the success summary. Otherwise
`Unknown`.

## Exit codes (filter mode)

A pipe loses the original command's exit code, as `| tail` does today. The filter
exits **1** when the outcome is `Fail`, else **0**. Claude therefore still sees a
failing status for recognised failures. The verdict line states the outcome in words.

## Error handling

| Situation | Behaviour |
|---|---|
| Hook: bad JSON, unreadable persisted file, any internal error or panic | Print nothing, exit 0. The original output reaches Claude. |
| Hook: saving is impossible and there is no `persistedOutputPath` | Do not trim. |
| Filter: a rule panics or errors | Fall back to `generic`; if that fails, pass input through unchanged. |
| Filter: saving the full log fails | Trim anyway; footer says `full log unavailable`. |
| Filter: input over 64 MB | Keep the first 64 MB; footer notes the truncation. |
| Invalid UTF-8 / console code page output | Lossy decode, never crash. |
| Session start: cannot determine exe path | Print the note without the fallback path line. |

Panics are caught with `std::panic::catch_unwind` around each mode's body.

### Log store

`%TEMP%\output-trim\YYYYMMDD-HHMMSS-<4 hex>.log`. On each save, logs older than 24 h
are deleted (best effort, errors ignored).

## Testing

- **Unit tests**: `normalize` (ANSI, `\r` progress, CRLF, invalid UTF-8),
  `collapse` (identical and template-identical runs), the engine (cap, overflow
  message, threshold, footer), rule selection by command (including `cd x &&`
  prefixes and existing pipes) and by content.
- **Fixture tests** (`tests/fixtures.rs`): real output captured from the user's
  projects, at least one pass and one fail case per rule: dotnet build/test
  (studio-e), cargo build/test/clippy (this workspace), pnpm and npm install,
  tsc with errors, vitest failure, a docker logs dump, docker build. Each test
  asserts the verdict, that every error and failed test name in the fixture
  survives, that known noise lines are gone, and the size reduction.
  Fixtures are scrubbed of secrets and hostnames before commit.
- **Hook protocol tests** (`tests/hook_protocol.rs`): run the built binary with
  PostToolUse JSON shaped exactly like the captured probe input (inline and
  `persistedOutputPath` variants, a gated-out command such as `git diff`, an
  already-piped command, malformed JSON) and assert on `updatedToolOutput`
  or silence. Also check session-start output.
- **Timing**: a test asserts the no-op hook path finishes under 20 ms (release build).
- **End-to-end (manual)**: install from the local marketplace, add the allow rule,
  and run a headless session that runs a failing test suite and `docker logs`. Check
  that the session-start note is present, Claude pipes into `output-trim`, the
  unpiped `docker logs` is trimmed, and `output-trim` resolves from the PowerShell
  tool (or the absolute-path fallback works).

## Distribution

- `scripts/release.ps1` builds `-p everything-find -p output-trim` in release mode
  and copies both exes into their plugin `bin/` folders.
- `output-trim.exe` is committed under `plugins/output-trim/bin/`.
- `.claude-plugin/marketplace.json` adds:
  `{ "name": "output-trim", "source": "./plugins/output-trim", "description": "Trims noisy build/test/log output to errors, failures and summaries." }`
- `plugins/output-trim/README.md` tells the user to add the allow rule
  `Bash(output-trim *)` (the binary only reads stdin and never executes anything,
  so the rule is safe).
