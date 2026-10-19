# everything-find — Design

Date: 2026-10-19
Status: Draft for review

## Context

This repo is a Claude Code plugin marketplace for plugins that make Claude faster
at finding things and cheaper in tokens. Three independent plugins are planned:

1. **everything-find** (this spec) — fast file/folder lookup via voidtools Everything.
2. **code-outline** (later spec) — symbol outlines and symbol-level reads via tree-sitter.
3. **output-trim** (later spec) — hooks that compress noisy Bash output.

All three are written in Rust and share one Cargo workspace.

## Goal

Give Claude a single MCP tool, `find`, that locates files and folders instantly —
in the current repo by default, anywhere on the machine on request — and returns
results in a compact, token-cheap text format.

### Success criteria

- A `find` call on a large repo returns in well under 100 ms (excluding Claude overhead).
- Repo-scope results contain no `.gitignore`d paths unless `include_ignored` is set.
- Output for N results uses noticeably fewer tokens than a flat list of absolute paths.
- When Everything is unavailable, Claude gets a one-line actionable message, not a crash.

### Non-goals

- **Content search.** Everything does not index file contents; Claude Code's Grep
  (ripgrep) is faster for that. Not offered.
- Building or maintaining an index. Everything already does this.
- Non-Windows support. Windows-only by design.
- Non-NTFS / network volumes not indexed by Everything.

## Environment assumptions

- Everything 1.4+ installed at `C:\Program Files\Everything` and running.
- SDK present at `C:\Program Files\Everything\sdk` (MIT licensed, includes
  `src/Everything.c` and `include/Everything.h`).
- `es.exe` 1.1.0.38 present — used only for manual testing, not by the plugin.

## Tool surface

One MCP tool: `find`.

| Param             | Type                                | Default  | Meaning |
|-------------------|-------------------------------------|----------|---------|
| `query`           | string (required)                   | —        | Everything search syntax, passed through (`*.tsx`, `dm:today`, wildcards, etc.) |
| `scope`           | `"repo"` \| `"all"`                 | `"repo"` | `repo` = repo root tree; `all` = entire machine |
| `path`            | string                              | none     | Restrict search to this folder (absolute, or relative to repo root). Overrides the scope root. |
| `kind`            | `"file"` \| `"dir"` \| `"any"`      | `"any"`  | Restrict to files or folders |
| `limit`           | integer, 1–500                      | `50`     | Max results returned |
| `sort`            | `"name"` \| `"modified"` \| `"size"`| `"name"` | `modified` and `size` sort descending (newest / largest first) |
| `details`         | bool                                | `false`  | Append size and modified date to each entry |
| `include_ignored` | bool                                | `false`  | Repo scope only: disable `.gitignore` and default-junk filtering |

The tool description must stay short: it is loaded into every session.

### Output format

Plain text. Header line, then entries grouped by parent folder, paths relative to
the root (absolute when `scope = "all"` without `path`).

```
37 matches, showing 20 (limit) — repo C:\Source\app
src/components/
  Button.tsx  Card.tsx  Modal.tsx
src/lib/
  api.ts  auth.ts
tests/
  api.test.ts
```

With `details: true`, each entry goes on its own line:

```
src/lib/
  api.ts   4.2 KB  2026-10-18 14:02
```

Folder results are shown with a trailing `/`. Groups are ordered by the first
appearance of each folder in the sorted result list, so `sort` stays meaningful.

## Architecture

### Repo layout

```
plugins/                                  (git repo, marketplace root)
  .claude-plugin/marketplace.json         lists all plugins
  plugins/everything-find/                installable plugin folder
    .claude-plugin/plugin.json
    .mcp.json                             command: ${CLAUDE_PLUGIN_ROOT}/bin/everything-find.exe
    bin/everything-find.exe               committed prebuilt binary
  crates/everything-find/
    vendor/everything-sdk/                Everything.c, Everything.h, LICENSE (copied from SDK)
    build.rs                              compiles Everything.c with the `cc` crate, links statically
    src/
      sdk.rs      FFI bindings + safe wrapper
      query.rs    builds the Everything search string from tool params
      filter.rs   .gitignore filtering
      format.rs   compact grouped output
      main.rs     rmcp stdio server, `find` tool definition, wiring
  scripts/release.ps1                     cargo build --release + copy exe into plugin bin/
  Cargo.toml                              workspace
```

### Units

- **`sdk.rs`**: the only module that touches FFI. Exposes
  `search(query: &str, opts: SearchOpts) -> Result<SearchPage, SdkError>` where
  `SearchOpts` holds sort, offset, max, and whether to request size/date, and
  `SearchPage` holds `entries: Vec<Entry { full_path, is_dir, size, modified }>`
  plus `total: u32`. It also exposes `status() -> Status { running, db_loaded }`.
  The Everything SDK uses global state and is not thread-safe, so every call is
  serialized behind a process-wide `Mutex`.
- **`query.rs`**: a pure function `(params, root) -> String`. Adds the root as a
  quoted path filter, maps `kind` to `file:` / `folder:`, and (repo scope, unless
  `include_ignored`) appends default excludes:
  `!\.git\ !\node_modules\ !\target\ !\bin\ !\obj\`. Its unit tests run without
  Everything.
- **`filter.rs`**: given the repo root, builds a matcher with the `ignore` crate
  (`ignore::gitignore`, honouring nested `.gitignore` files and `.git/info/exclude`)
  and answers `is_ignored(path, is_dir)`. Knows nothing about Everything.
- **`format.rs`**: a pure function `(entries, total, shown, root, details) -> String`.
  Knows nothing about Everything or git.
- **`main.rs`**: an `rmcp` stdio server. Defines the tool schema, validates params,
  resolves the root, and runs query → paged search → filter → format.

### Data flow for one `find` call

1. Resolve the root: `path` if given, else the process working directory
   (`scope = "repo"`), else none (`scope = "all"`).
2. `query.rs` builds the search string.
3. Paged search: fetch pages of `max(limit * 2, 100)` results with an increasing
   offset. Run each entry through `filter.rs` (repo scope only) and stop when
   `limit` entries survive or Everything runs out. Hard stop after 10 pages, and
   report the cap in the header.
4. `format.rs` renders the result. The header's match count is Everything's total
   when filtering removed nothing. Otherwise it reads `≥N matches` (or states the
   exact count when all pages were consumed).

### Repo root

The MCP server's working directory is taken to be the project folder that Claude
Code launched it from. **This must be verified during implementation.** If it
doesn't hold, fall back to the `CLAUDE_PROJECT_DIR` environment variable if
present, then to walking up from the cwd to the nearest `.git`. `path` always
overrides the root.

## Error handling

Every failure becomes a normal tool result (text) that tells Claude what to do
next. The server never panics on bad input.

| Situation | Message to Claude |
|---|---|
| IPC fails (Everything not running) | `Everything is not running — start it, or use Glob instead.` |
| `Everything_IsDBLoaded` false | Warning line `Everything is still indexing; results may be incomplete.` then results |
| Invalid query syntax / SDK error | `Everything rejected the query: <reason>` plus a one-line syntax hint |
| Zero results | `0 matches for <query> in <root>` |
| Zero after filtering, >0 before | As above, plus `(N hidden by .gitignore — retry with include_ignored: true)` |
| `path` not found or not indexed | `<path> is not indexed by Everything (non-NTFS or excluded) — use Glob.` |
| Invalid params (limit out of range, etc.) | MCP invalid-params error with the offending field |

There is no silent fallback to a filesystem walk: Claude already has Glob, so a
clear message is cheaper than a hidden slow path.

## Testing

- **Unit tests** (`cargo test`, no Everything needed):
  - `query.rs`: scope/kind/exclude/path mapping, quoting of paths with spaces.
  - `filter.rs`: temp dir with nested `.gitignore` files, negation rules, directory rules.
  - `format.rs`: grouping, ordering, truncation header, `details` layout,
    relative vs absolute paths, folder trailing `/`.
- **Integration tests** (`#[ignore]`, run with `cargo test -- --ignored` on a
  machine where Everything is running): create a temp folder with known files,
  poll until Everything sees them (timeout 10 s), then run the full `find`
  pipeline and assert on the output. Also cover `sort = "modified"` and the
  "hidden by .gitignore" message.
- **End-to-end (manual)**: add this repo as a local marketplace in Claude Code,
  install `everything-find`, and confirm Claude calls `find` and gets compact output.

## Distribution

`scripts/release.ps1` runs `cargo build --release -p everything-find` and copies
`target/release/everything-find.exe` into `plugins/everything-find/bin/`. The
binary is committed. Moving to GitHub Releases is deferred until the plugins
are shared beyond the author.

## Dependencies

- `rmcp` (official Rust MCP SDK): stdio server, tool macros
- `tokio`: async runtime required by `rmcp`
- `serde`, `schemars`: tool parameter schema
- `ignore`: gitignore matching
- `cc` (build): compile vendored `Everything.c`
- `windows-sys` or plain `std` FFI types: only as needed by the bindings
