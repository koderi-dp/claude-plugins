# everything-find Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Windows-only Claude Code plugin whose Rust MCP server exposes one `find` tool backed by the voidtools Everything index, returning compact, `.gitignore`-aware results.

**Architecture:** One Cargo workspace crate `everything-find` (a lib and a thin bin). The vendored Everything SDK C source is compiled in with `cc`, so the exe needs no DLL. Pure modules (`query`, `filter`, `format`) feed a `pipeline` that talks to Everything through a `Searcher` trait, so paging and filtering can be tested with a fake. `server` wraps the pipeline in an `rmcp` stdio server.

**Tech Stack:** Rust 1.99 (stable-x86_64-pc-windows-msvc, VS 18 Community build tools present), rmcp 3.5.1 (`server`, `macros`, `transport-io`), tokio, serde, schemars, ignore 0.4, dunce, chrono, cc (build).

**Spec:** `docs/superpowers/specs/2026-10-19-everything-find-design.md`

**Refinements to the spec (decided here):**
- `main.rs` is split into `pipeline.rs` (search → filter → format, testable) and `server.rs` (rmcp wiring). `lib.rs` exposes the modules to integration tests.
- Repo root: `CLAUDE_PROJECT_DIR` if set and the folder exists, else the process cwd. Task 6 verifies what Claude Code actually provides.
- The user's query is wrapped in Everything's `<…>` grouping, so an `|` inside it can't escape the root/kind/exclude filters.

## Global Constraints

- Windows only. Everything 1.4+ must be running. The SDK source comes from `C:\Program Files\Everything\sdk` (MIT; keep its copyright notice in `vendor/everything-sdk/LICENSE`).
- One MCP tool named `find`. Params: `query` (required), `scope` `"repo"|"all"` = `"repo"`, `path`, `kind` `"file"|"dir"|"any"` = `"any"`, `limit` 1–500 = `50`, `sort` `"name"|"modified"|"size"` = `"name"` (modified/size descending), `details` = `false`, `include_ignored` = `false`.
- Default excludes (repo scope, unless `include_ignored`): `!\.git\ !\node_modules\ !\target\ !\bin\ !\obj\`
- Page size `max(limit * 2, 100)`, at most 10 pages per call.
- No content search. No filesystem-walk fallback. The server never panics on bad input.
- Error copy, verbatim:
  - `Everything is not running — start it, or use Glob instead.`
  - `Everything is still indexing; results may be incomplete.`
  - `Everything rejected the query: <reason>`
  - `0 matches for <query> in <root>`
  - `(N hidden by .gitignore — retry with include_ignored: true)`
  - `<path> is not indexed by Everything (non-NTFS or excluded) — use Glob.`
- Tool description, verbatim: `Instantly find files/folders by name via the Everything index (Windows). Defaults to the current repo and respects .gitignore; scope:"all" searches every drive. Query uses Everything syntax (wildcards, ext:, dm:today). Not for content search — use Grep.`

## Review Focus

1. **Paths with spaces or non-ASCII characters** (`C:\Users\Đorđe\My Repo`): the query quotes the root correctly and wide strings round-trip. Test in Task 2 and Task 6.
2. **Root casing differs from Everything's casing** (cwd `c:\source\app`, Everything returns `C:\Source\App\…`): relative paths and `.gitignore` matching still work. Prefixes are stripped case-insensitively. Test in Task 3 and Task 4.
3. **Paths longer than 260 characters**: never truncated. The result buffer is 32 768 wide chars. Test in Task 1 (helper) and Task 6.
4. **`path` given relative, with `/` or `..`** (`src/../tests`): it resolves against the repo root to a real folder, and a missing folder gives the "not indexed" message. Test in Task 5.
5. **Root with no `.gitignore` / not a git repo**: the filter is a no-op and nothing is hidden. Test in Task 3.

---

## File Structure

```
.gitignore                                   /target
Cargo.toml                                   workspace: members = ["crates/*"]
.claude-plugin/marketplace.json
plugins/everything-find/.claude-plugin/plugin.json
plugins/everything-find/.mcp.json
plugins/everything-find/bin/everything-find.exe   (built, committed)
scripts/release.ps1
crates/everything-find/
  Cargo.toml
  build.rs
  vendor/everything-sdk/{Everything.c, Everything.h, LICENSE}
  src/lib.rs        pub mod sdk; query; filter; format; pipeline; server;
  src/main.rs       tokio main → server::run()
  src/sdk.rs        FFI + EverythingSdk (impl Searcher)
  src/query.rs      build_query
  src/filter.rs     IgnoreFilter
  src/format.rs     render, human_size, strip_root
  src/pipeline.rs   FindParams, Searcher trait, run_find, resolve_root
  src/server.rs     rmcp tool router
  tests/live.rs     #[ignore] tests against running Everything
```

---

### Task 1: Workspace, vendored SDK, FFI wrapper

**Files:**
- Create: `.gitignore`, `Cargo.toml`, `crates/everything-find/Cargo.toml`, `crates/everything-find/build.rs`, `crates/everything-find/vendor/everything-sdk/*`, `crates/everything-find/src/lib.rs`, `crates/everything-find/src/main.rs` (stub `fn main(){}` for now), `crates/everything-find/src/sdk.rs`, `crates/everything-find/src/pipeline.rs` (types only, see below)
- Test: unit tests in `sdk.rs`; `crates/everything-find/tests/live.rs`

**Interfaces:**
- Produces (in `pipeline.rs`, shared types):
  - `pub enum SortKey { Name, Modified, Size }`
  - `pub struct SearchOpts { pub sort: SortKey, pub offset: u32, pub max: u32, pub want_details: bool }`
  - `pub struct Entry { pub full_path: PathBuf, pub is_dir: bool, pub size: Option<u64>, pub modified: Option<i64> /* unix secs */ }`
  - `pub struct SearchPage { pub entries: Vec<Entry>, pub total: u32 }`
  - `pub struct Status { pub running: bool, pub db_loaded: bool }`
  - `pub enum SdkError { NotRunning, Rejected(String) }`
  - `pub trait Searcher: Send + Sync { fn search(&self, query: &str, opts: &SearchOpts) -> Result<SearchPage, SdkError>; fn status(&self) -> Status; }`
- Produces (in `sdk.rs`): `pub struct EverythingSdk;` implementing `Searcher`; `pub fn filetime_to_unix(ft: u64) -> Option<i64>`

- [ ] **Step 1: Scaffold the workspace.** `lib.rs` declares only the modules that exist so far (`sdk`, `pipeline`); each later task adds its own `pub mod`. Copy `Everything.c` and `Everything.h` from `C:\Program Files\Everything\sdk\{src,include}` into `vendor/everything-sdk/`. Copy the voidtools MIT block from `C:\Program Files\Everything\License.txt` into `LICENSE`. The crate's `Cargo.toml` declares `[lib]` and `[[bin]] name = "everything-find"`, plus the deps from the Tech Stack. `build.rs`: `cc::Build::new().file("vendor/everything-sdk/Everything.c").include("vendor/everything-sdk").compile("everything_sdk");` then `println!("cargo:rustc-link-lib=user32");` and a `rerun-if-changed` for the vendor dir.

- [ ] **Step 2: Write the failing tests** in `sdk.rs`:

```rust
#[test] fn filetime_epoch() { assert_eq!(filetime_to_unix(116_444_736_000_000_000), Some(0)); }
#[test] fn filetime_known() { assert_eq!(filetime_to_unix(133_000_000_000_000_000), Some(1_655_526_400)); }
#[test] fn filetime_zero_is_none() { assert_eq!(filetime_to_unix(0), None); }
#[test] fn result_buffer_fits_long_paths() { assert_eq!(PATH_BUF_WCHARS, 32_768); }
```

And in `tests/live.rs` (`#[ignore]`): `status_reports_running` asserts `EverythingSdk.status().running`. `finds_own_cargo_toml` searches `"<crate dir>\" Cargo.toml` with `max: 10` and asserts that an entry equals `<crate dir>\Cargo.toml` with `is_dir == false`.

- [ ] **Step 3: Run** `cargo test -p everything-find`. Expected: compile errors (functions undefined).

- [ ] **Step 4: Implement `sdk.rs`.** `extern "system"` declarations for: `Everything_SetSearchW`, `Everything_SetRequestFlags`, `Everything_SetSort`, `Everything_SetOffset`, `Everything_SetMax`, `Everything_QueryW`, `Everything_GetLastError`, `Everything_GetNumResults`, `Everything_GetTotResults`, `Everything_IsFolderResult`, `Everything_GetResultFullPathNameW`, `Everything_GetResultSize`, `Everything_GetResultDateModified`, `Everything_IsDBLoaded`, `Everything_GetMajorVersion`. Constants:
  - sort: Name = 1, Size = 6 (descending), Modified = 14 (descending)
  - request flags: `0x4` full path, plus `0x10 | 0x40` when `want_details`
  - errors: IPC = 2 → `NotRunning`; anything else non-zero → `Rejected("Everything error code N")`

  A `static LOCK: Mutex<()>` guards every call (the SDK keeps global state). `PATH_BUF_WCHARS = 32_768`. FILETIME → unix: `(ft - 116_444_736_000_000_000) / 10_000_000`, returning `None` for 0. `status()`: `running = Everything_GetMajorVersion() != 0`; `db_loaded = Everything_IsDBLoaded() != 0`.

- [ ] **Step 5: Run** `cargo test -p everything-find`, then `cargo test -p everything-find --test live -- --ignored`. Expected: all PASS (Everything is running on this machine).

- [ ] **Step 6: Commit** `git add -A && git commit -m "feat(everything-find): workspace, vendored SDK, FFI wrapper"`

---

### Task 2: Query builder

**Files:**
- Create: `crates/everything-find/src/query.rs` (tests inline)

**Interfaces:**
- Produces: `pub enum Kind { File, Dir, Any }` and `pub fn build_query(user_query: &str, root: Option<&Path>, kind: Kind, default_excludes: bool) -> String`

Output shape: the parts joined by single spaces, empty parts skipped: `"<root>\"`, `file:` / `folder:`, `!\.git\ !\node_modules\ !\target\ !\bin\ !\obj\`, `<user_query>`. The root always gets exactly one trailing backslash.

- [ ] **Step 1: Write failing tests**

```rust
#[test] fn all_scope_plain() { assert_eq!(build_query("*.rs", None, Kind::Any, false), "<*.rs>"); }
#[test] fn repo_scope_full() {
    assert_eq!(build_query("foo | bar", Some(Path::new(r"C:\Source\app")), Kind::File, true),
        r#""C:\Source\app\" file: !\.git\ !\node_modules\ !\target\ !\bin\ !\obj\ <foo | bar>"#);
}
#[test] fn dir_kind() { assert!(build_query("x", None, Kind::Dir, false).starts_with("folder: ")); }
#[test] fn root_with_trailing_slash_not_doubled() {
    assert!(build_query("x", Some(Path::new(r"C:\a\")), Kind::Any, false).starts_with(r#""C:\a\" "#));
}
#[test] fn root_with_spaces_and_unicode() {
    assert!(build_query("x", Some(Path::new(r"C:\Users\Đorđe\My Repo")), Kind::Any, false)
        .starts_with(r#""C:\Users\Đorđe\My Repo\" "#));
}
```

- [ ] **Step 2: Run** `cargo test -p everything-find query`. Expected: FAIL (not defined).
- [ ] **Step 3: Implement `build_query`.**
- [ ] **Step 4: Run** `cargo test -p everything-find query`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -am "feat(everything-find): query builder"` (add the new file first)

---

### Task 3: `.gitignore` filter

**Files:**
- Create: `crates/everything-find/src/filter.rs` (tests inline, using `tempfile` as a dev-dependency)

**Interfaces:**
- Produces: `pub struct IgnoreFilter`, `pub fn IgnoreFilter::new(root: &Path) -> IgnoreFilter`, `pub fn is_ignored(&mut self, path: &Path, is_dir: bool) -> bool`, and `pub fn strip_root_ci<'a>(path: &'a Path, root: &Path) -> Option<PathBuf>` (case-insensitive prefix strip that returns the relative path; `format` reuses it)

**Algorithm.** It's lazy, with one matcher per directory, cached in a `HashMap<PathBuf, Option<Gitignore>>`:
1. `rel = strip_root_ci(path, root)`. If that's `None`, return `false`.
2. For each ancestor directory `D` from `root` down to `path`'s parent:
   - Load `D\.gitignore`. For `root`, also add `root\.git\info\exclude`.
   - Build it with `GitignoreBuilder::new(D)`.
   - Call `matched_path_or_any_parents(root.join(rel), is_dir)`. Always pass `root.join(rel)`, never Everything's casing, so the matcher's precondition holds.
3. The deepest non-`None` match wins: `Ignore` → true, `Whitelist` → false. No match at any level → false.

- [ ] **Step 1: Write failing tests** with a tempdir fixture: root `.gitignore` = `*.log\nbuild/\n!keep.log`, and `sub\.gitignore` = `secret.txt`.

```rust
#[test] fn ignores_by_glob()        { assert!(f.is_ignored(&root.join("a.log"), false)); }
#[test] fn whitelist_wins()         { assert!(!f.is_ignored(&root.join("keep.log"), false)); }
#[test] fn ignored_parent_dir()     { assert!(f.is_ignored(&root.join(r"build\out\x.js"), false)); }
#[test] fn nested_gitignore()       { assert!(f.is_ignored(&root.join(r"sub\secret.txt"), false));
                                      assert!(!f.is_ignored(&root.join("secret.txt"), false)); }
#[test] fn case_mismatched_root()   { let upper = PathBuf::from(root.to_string_lossy().to_uppercase());
                                      assert!(f.is_ignored(&upper.join("A.LOG"), false)); }
#[test] fn no_gitignore_is_noop()   { /* empty tempdir */ assert!(!f2.is_ignored(&empty.join("a.log"), false)); }
#[test] fn outside_root_not_ignored(){ assert!(!f.is_ignored(Path::new(r"Z:\elsewhere\a.log"), false)); }
```

(`case_mismatched_root` relies on gitignore matching being case-insensitive on Windows. If `ignore` matches case-sensitively, set `GitignoreBuilder::case_insensitive(true)`.)

- [ ] **Step 2: Run** `cargo test -p everything-find filter`. Expected: FAIL.
- [ ] **Step 3: Implement** `IgnoreFilter` and `strip_root_ci`. `strip_root_ci` compares path components with `eq_ignore_ascii_case` on ASCII and `to_lowercase` otherwise.
- [ ] **Step 4: Run** `cargo test -p everything-find filter`. Expected: PASS.
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat(everything-find): gitignore filter"`

---

### Task 4: Output formatter

**Files:**
- Create: `crates/everything-find/src/format.rs` (tests inline)

**Interfaces:**
- Consumes: `Entry` (Task 1), `strip_root_ci` (Task 3)
- Produces:
  - `pub struct Header { pub count: u32, pub count_is_lower_bound: bool, pub shown: usize, pub scope_label: String, pub page_capped: bool, pub hidden_by_ignore: u32, pub indexing: bool }`
  - `pub fn render(entries: &[Entry], header: &Header, root: Option<&Path>, details: bool) -> String`
  - `pub fn human_size(bytes: u64) -> String`

**Rules:**
- **Optional first line:** `Everything is still indexing; results may be incomplete.`
- **Header line:** `{count}{"≥" prefix if lower bound} matches, showing {shown}{" (limit)" if shown < count} — {scope_label}`. Then append ` (scan capped at 10 pages)` if `page_capped`, and ` (N hidden by .gitignore — retry with include_ignored: true)` if `hidden_by_ignore > 0`. The `≥` goes before the number: `≥40 matches`.
- **`scope_label`** is computed by the pipeline: `repo C:\Source\app`, `C:\some\path`, or `all drives`.
- **Groups:** keyed by the parent folder relative to `root` (absolute when `root` is `None`), written with `/` separators and a trailing `/`. The repo root's own files go under `./`. Groups appear in order of first appearance, and entries keep their sort order within a group. Folder entries get a trailing `/`.
- **Without `details`:** `  ` plus the names joined with two spaces, on one line.
- **With `details`:** one entry per line: `  {name}  {human_size}  {YYYY-MM-DD HH:MM local}`. Folders omit the size. Missing values are omitted.
- **`human_size`:** `512 B`, `4.2 KB`, `1.0 MB`, `3.5 GB` (1024 base, one decimal place above bytes).

- [ ] **Step 1: Write failing tests**

```rust
#[test] fn grouped_relative() {
    // entries: root\src\b.rs, root\src\a.rs, root\README.md, root\src\lib (dir)
    assert_eq!(render(&e, &hdr(4, 4, "repo C:\\r"), Some(root), false),
        "4 matches, showing 4 — repo C:\\r\nsrc/\n  b.rs  a.rs  lib/\n./\n  README.md\n");
}
#[test] fn truncated_lower_bound_hidden() {
    assert!(render(&e, &Header{count:40, count_is_lower_bound:true, shown:20, hidden_by_ignore:3, ..h}, Some(root), false)
        .starts_with("≥40 matches, showing 20 (limit) — repo C:\\r (3 hidden by .gitignore — retry with include_ignored: true)\n"));
}
#[test] fn indexing_warning_first_line() { assert!(out.starts_with("Everything is still indexing; results may be incomplete.\n")); }
#[test] fn absolute_when_no_root() { assert!(out.contains("C:/x/y/\n  z.txt")); }
#[test] fn case_mismatched_root_stays_relative() { /* root c:\r, entry C:\R\src\a.rs */ assert!(out.contains("src/\n  a.rs")); }
#[test] fn details_layout() { assert!(out.contains("  api.ts  4.2 KB  ")); }
#[test] fn sizes() { assert_eq!(human_size(512), "512 B"); assert_eq!(human_size(4300), "4.2 KB"); assert_eq!(human_size(1_048_576), "1.0 MB"); }
```

- [ ] **Step 2: Run** `cargo test -p everything-find format`. Expected: FAIL.
- [ ] **Step 3: Implement `render` and `human_size`** (chrono `Local` for dates).
- [ ] **Step 4: Run** `cargo test -p everything-find format`. Expected: PASS.
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat(everything-find): compact output formatter"`

---

### Task 5: Pipeline (`run_find`)

**Files:**
- Modify: `crates/everything-find/src/pipeline.rs` (add the logic below the Task 1 types; tests inline, with a `FakeSearcher`)

**Interfaces:**
- Consumes: `Searcher`, `SearchOpts`, `SdkError`, `Status` (Task 1); `build_query`, `Kind` (Task 2); `IgnoreFilter` (Task 3); `render`, `Header` (Task 4)
- Produces:
  - `#[derive(Deserialize, JsonSchema)] pub struct FindParams { query: String, scope: Scope /*Repo default*/, path: Option<String>, kind: KindParam /*Any*/, limit: u32 /*50*/, sort: SortParam /*Name*/, details: bool, include_ignored: bool }`. Use lowercase serde renames (`"repo"`, `"all"`, `"file"`, `"dir"`, `"any"`, `"name"`, `"modified"`, `"size"`), serde defaults, and a short `///` doc on each field (these become the schema descriptions).
  - `pub struct Context { pub cwd: PathBuf, pub project_dir: Option<PathBuf> }` with `Context::from_env()`
  - `pub fn resolve_root(params: &FindParams, ctx: &Context) -> Result<Option<PathBuf>, String>`. `Err` carries the full "not indexed" message.
  - `pub fn run_find(params: &FindParams, ctx: &Context, s: &dyn Searcher) -> Result<String, String>`. `Err` means invalid params only. Everything else is `Ok(text)`.

**Behaviour:**
1. **Validate.** `limit` outside 1–500 → `Err("limit must be between 1 and 500")`. An empty `query` → `Err("query must not be empty")`.
2. **Repo root.** `project_dir` if `Some` and it exists, else `cwd`.
3. **`resolve_root`.**
   - If `path` is set: absolute paths are used as given; relative paths are joined to the repo root. The result goes through `dunce::canonicalize`. Failure → `Err(format!("{path} is not indexed by Everything (non-NTFS or excluded) — use Glob."))`.
   - If `path` is not set: `scope = repo` → the repo root; `scope = all` → `None`.
4. **Status.** `!running` → `Ok("Everything is not running — start it, or use Glob instead.")`.
5. **Filtering.** It's active when `scope == repo && !include_ignored`. In that case `default_excludes = true`, and the filter root is the repo root if the search root is under it (via `strip_root_ci`), else the search root.
6. **Paging.** `max = max(limit*2, 100)` per page, `offset += page.entries.len()`, stopping when `limit` entries are kept, when the page is empty, when `offset >= total`, or after 10 pages (`page_capped = true` if matches remained).
   - `NotRunning` → the not-running message.
   - `Rejected(r)` → `Ok(format!("Everything rejected the query: {r}\nHint: wrap paths in quotes; use | for OR, ! for NOT, ext:rs, dm:today."))`
7. **Count.** `hidden == 0` → Everything's `total`. Otherwise, if every page was consumed → the exact count `total - hidden`; if not → `total - hidden_so_far` with `count_is_lower_bound = true`.
8. **Zero kept.** `Ok(format!("0 matches for {query} in {root_or_all_drives}"))`, plus the hidden note (with a leading space) when `hidden > 0`.

- [ ] **Step 1: Write failing tests.** `FakeSearcher` holds a `Vec<Entry>`, a `Status`, and an optional error. It records the query and opts it was called with, and serves pages by `offset`/`max`.

```rust
#[test] fn not_running()            { assert_eq!(run(fake_down()), Ok("Everything is not running — start it, or use Glob instead.".into())); }
#[test] fn limit_out_of_range()     { assert!(run_with(limit(0)).is_err()); assert!(run_with(limit(501)).is_err()); }
#[test] fn pages_until_limit()      { /* 300 entries, half under ignored build/ */ assert_eq!(kept_count(limit(120)), 120); assert!(fake.calls() >= 2); }
#[test] fn page_cap_at_ten()        { /* 5000 entries all ignored but last */ assert!(out.contains("(scan capped at 10 pages)")); assert_eq!(fake.calls(), 10); }
#[test] fn zero_after_filter_hint() { assert!(out.starts_with("0 matches for *.log in ") && out.contains("hidden by .gitignore")); }
#[test] fn include_ignored_disables(){ assert!(!fake.last_query().contains(r"!\node_modules\")); }
#[test] fn rejected_passthrough()   { assert!(out.starts_with("Everything rejected the query: Everything error code 9")); }
#[test] fn relative_path_normalised(){ /* tempdir with src/, tests/ */ assert_eq!(resolve_root(&p("src/../tests"), &ctx).unwrap(), Some(dunce::canonicalize(tmp.join("tests")).unwrap())); }
#[test] fn missing_path_message()   { assert_eq!(resolve_root(&p("nope"), &ctx).unwrap_err(), "nope is not indexed by Everything (non-NTFS or excluded) — use Glob."); }
#[test] fn project_dir_preferred()  { assert_eq!(repo_root(&Context{cwd: a, project_dir: Some(b)}), b); }
#[test] fn sort_maps()              { assert_eq!(fake.last_opts().sort, SortKey::Modified); }
```

- [ ] **Step 2: Run** `cargo test -p everything-find pipeline`. Expected: FAIL.
- [ ] **Step 3: Implement** `Context::from_env`, `resolve_root`, and `run_find` as specified.
- [ ] **Step 4: Run** `cargo test -p everything-find`. Expected: all unit tests PASS.
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat(everything-find): find pipeline with paging and filtering"`

---

### Task 6: MCP server, plugin packaging, live verification

**Files:**
- Create: `crates/everything-find/src/server.rs`, `scripts/release.ps1`, `.claude-plugin/marketplace.json`, `plugins/everything-find/.claude-plugin/plugin.json`, `plugins/everything-find/.mcp.json`, `plugins/everything-find/bin/everything-find.exe` (built)
- Modify: `crates/everything-find/src/main.rs`, `crates/everything-find/tests/live.rs`

**Interfaces:**
- Consumes: `FindParams`, `Context`, `run_find` (Task 5); `EverythingSdk` (Task 1)
- Produces: `pub async fn server::run() -> anyhow::Result<()>`

- [ ] **Step 1: Write failing live tests** (`#[ignore]`) in `tests/live.rs`. Each one creates a fresh folder under `std::env::temp_dir()` named `ef-live-<pid>-Đ é` (a space plus non-ASCII), then polls `run_find` every 200 ms until a sentinel file appears (10 s timeout).
  - `live_repo_scope_filters_gitignore`: write `.gitignore` = `*.log`, plus `a.rs` and `b.log`. With `cwd` = the folder, the output contains `a.rs` and not `b.log`.
  - `live_sort_modified`: write `old.txt`, then 1.1 s later `new.txt`. With `sort: modified`, `new.txt` appears before `old.txt`.
  - `live_long_path`: create a nested path with more than 300 chars total holding `deep.txt`. The output contains `deep.txt` and the full relative group path.
  - `live_include_ignored_shows_log`: with `include_ignored: true`, the output contains `b.log`.

- [ ] **Step 2: Run** `cargo test -p everything-find --test live -- --ignored`. Expected: PASS, since the pipeline already exists. Any failure is a real bug in Tasks 1–5: fix it there before continuing.

- [ ] **Step 3: Implement `server.rs`.** Follow the rmcp 3.5.1 `#[tool_router]` / `#[tool]` / `#[tool_handler]` pattern; confirm the exact macro and `serve(stdio())` shape against rmcp docs (context7). Build one tool, `find`, with the exact description from Global Constraints and `Parameters<FindParams>`. Run the call in `tokio::task::spawn_blocking` with a fresh `Context::from_env()` and `EverythingSdk`. `Ok(text)` → a text result; `Err(msg)` → `McpError::invalid_params(msg, None)`. Server info: name `everything-find`, version from `CARGO_PKG_VERSION`. `main.rs`: `#[tokio::main] async fn main() -> anyhow::Result<()> { everything_find::server::run().await }`. Log only to stderr.

- [ ] **Step 4: Create the packaging files**

```json
// .claude-plugin/marketplace.json
{ "name": "code101-plugins", "owner": { "name": "Danijel Peric" },
  "plugins": [ { "name": "everything-find", "source": "./plugins/everything-find",
                 "description": "Instant file/folder lookup via voidtools Everything (Windows)." } ] }
// plugins/everything-find/.claude-plugin/plugin.json
{ "name": "everything-find", "version": "0.1.0",
  "description": "Instant file/folder lookup via voidtools Everything (Windows)." }
// plugins/everything-find/.mcp.json
{ "mcpServers": { "everything-find": { "command": "${CLAUDE_PLUGIN_ROOT}/bin/everything-find.exe" } } }
```

`scripts/release.ps1` runs `cargo build --release -p everything-find`, copies `target\release\everything-find.exe` into `plugins\everything-find\bin\` (creating the folder), and stops on any error (`$ErrorActionPreference = 'Stop'`, checking `$LASTEXITCODE`).

- [ ] **Step 5: Smoke-test the protocol.** Run `pwsh scripts/release.ps1`, then pipe an MCP `initialize` request, an `initialized` notification and a `tools/list` request (JSON lines) into `plugins\everything-find\bin\everything-find.exe`. Expected: `tools/list` returns exactly one tool, `find`, with the verbatim description and all 8 params.

- [ ] **Step 6: Verify end to end in Claude Code.** Add this repo as a local marketplace (`/plugin marketplace add C:\Source\projects\claude\plugins`), install `everything-find`, start a session in some repo, and ask Claude to find `*.toml` files.
  - Expected: Claude calls `find` and gets grouped, relative output.
  - Also check whether `CLAUDE_PROJECT_DIR` is set for the server and whether the cwd is the project folder (temporarily log both to stderr, then remove). Record the finding in the spec's "Repo root" section.

- [ ] **Step 7: Commit** `git add -A && git commit -m "feat(everything-find): MCP server and plugin packaging"`
