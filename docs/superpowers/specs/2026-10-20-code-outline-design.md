# code-outline — Design

Date: 2026-10-20
Status: Draft for review

## Context

Second of the three plugins in this marketplace (see
`2026-10-19-everything-find-design.md`): **everything-find** (done),
**code-outline** (this spec), **output-trim** (later). Same conventions: Rust,
one Cargo workspace, prebuilt exe committed into the plugin folder, MCP stdio
server built on `rmcp` 3.5.1.

## Goal

Cut the tokens Claude spends reading code. Instead of reading a whole file to find
one function, Claude asks for the file's **outline** (symbols with line ranges) and
then reads **just one symbol**.

### Success criteria

- `outline` of a source file costs ≥5× fewer tokens than reading that file.
- `read_symbol` output is line-numbered exactly like Read, so Claude can Edit
  straight after it without re-reading.
- Files with syntax errors (half-written code) still give a useful outline.
- All six grammars compile into the exe offline with MSVC; no runtime downloads, no DLLs.
- Outlining `crates/**/*.rs` in this repo returns in under 100 ms.

Verified (2026-10-20), release build:

- `code-outline.exe` is 14,563,328 bytes (13.9 MiB), all six grammars statically linked.
- `outline {"paths": "crates/**/*.rs", "limit": 500}` through the exe over stdio from the
  repo root: 45-52 ms per call (3 runs, warm process), 14.5 KB of output.
- `outline` of `crates/everything-find/src/pipeline.rs` is 2,382 bytes against a
  27,210-byte file: 11.4x smaller (bytes as a token proxy), above the 5x target.
- A headless `claude -p --plugin-dir plugins/code-outline` run called the `outline` tool
  on `crates/everything-find/src/server.rs` and answered `fn find` is lines 20-28.

### Non-goals

- Semantic analysis (types, references, go-to-definition). Claude Code's `LSP`
  tool covers that where a language server exists.
- Caching or indexing. Every call re-parses; parsing a typical file takes ~1 ms.
- Fields, local variables, imports.
- Languages beyond the six grammars below (adding one is a table row + a query file).

## Languages

| Lang       | Extensions                 | Grammar crate                          |
|------------|----------------------------|----------------------------------------|
| Rust       | `rs`                       | `tree-sitter-rust` 0.24                |
| TypeScript | `ts`, `mts`, `cts`         | `tree-sitter-typescript` 0.23 (`LANGUAGE_TYPESCRIPT`) |
| TSX        | `tsx`                      | `tree-sitter-typescript` 0.23 (`LANGUAGE_TSX`) |
| JavaScript | `js`, `jsx`, `mjs`, `cjs`  | `tree-sitter-javascript` 0.25          |
| Python     | `py`, `pyi`                | `tree-sitter-python` 0.25              |
| C#         | `cs`                       | `tree-sitter-c-sharp` 0.23             |

Core: `tree-sitter` 0.27. All grammar crates are maintained by the tree-sitter org
and compile their C parser at build time with `cc`.

### Kinds captured

Labels use each language's own keyword, so the outline reads like the code.

| Lang       | Kinds |
|------------|-------|
| Rust       | `fn`, `struct`, `enum`, `trait`, `impl`, `mod`, `macro`, `type`, `const`, `static` |
| TS / TSX   | `function`, `class`, `method`, `constructor`, `interface`, `type`, `enum`, `namespace`; a `const`/`let` bound to an arrow function or function expression is shown as `function` |
| JavaScript | as TS, minus `interface`, `type`, `enum`, `namespace` |
| Python     | `class`, `def`, `async def` |
| C#         | `namespace`, `class`, `struct`, `record`, `interface`, `enum`, `method`, `constructor`, `property` |

### Libraries considered and rejected

- **`tree-sitter-language-pack`** (372 languages, has a structure extractor):
  downloads parsers at runtime by default and fetches grammar sources at build time
  even in static mode; decorators not populated; young, large API. Its signature
  rule (source from item start to body start) is borrowed.
- **`tree-sitter-tags`**: flat output, so nesting is still ours; adds little over
  `tree_sitter::Query`.
- **`ast-grep-*`**: structural search/rewrite; bundles many grammars, larger exe.
- **`syn`**: Rust-only and fails on code that does not parse.
- **Bundled `TAGS_QUERY`s** in the grammar crates: too thin (C# has no
  struct/enum/record/property/constructor; Python does not tell methods apart).
  Used only as a starting point for our own queries.

## Tool surface

Two MCP tools. Descriptions stay short: they load into every session.

### `outline`

Description: `List the symbols (functions, classes, methods…) in source files with line ranges, without reading the bodies. Rust, TS/JS, Python, C#. Use before Read to find what you need, then read_symbol.`

| Param        | Type                          | Default | Meaning |
|--------------|-------------------------------|---------|---------|
| `paths`      | string or string[] (required) | —       | Files or globs (`src/**/*.{ts,tsx}`), absolute or relative to the repo root |
| `signatures` | bool                          | `false` | Show each symbol's signature instead of just its name |
| `limit`      | integer, 1–500                | `50`    | Max files |

Globs respect `.gitignore` (same rules as everything-find: nested `.gitignore`,
`.git/info/exclude`, git root) and silently skip unsupported files. Files are
sorted by path.

Output (plain text, two-space indent per nesting level, `start-end` 1-based inclusive):

```
src/api/client.ts (210 lines)
  interface ClientOptions 5-12
  class ApiClient 14-180
    constructor 18-30
    method get 32-60
    method post 62-95
  function createClient 182-209
```

With `signatures: true` the name is replaced by the signature:

```
  impl FindServer 14-30
    pub fn new() -> Self 15-17
    async fn find(&self, Parameters(params): Parameters<FindParams>) -> Result<String, ErrorData> 20-29
```

Rust `impl` blocks are labelled `impl Type` or `impl Trait for Type`, generics dropped.
Files are separated by a blank line. Doc comments are never shown in the outline.

### `read_symbol`

Description: `Read one symbol's source (with its doc comments and attributes) from a file, line-numbered like Read. symbol is a name or qualified path: ApiClient.get, FindServer::find.`

| Param    | Type              | Default | Meaning |
|----------|-------------------|---------|---------|
| `path`   | string (required) | —       | One file, absolute or relative to the repo root |
| `symbol` | string (required) | —       | `name`, or a qualified path with `.` or `::` separators |
| `line`   | integer           | none    | Pick the symbol whose range contains this line when several match |

Output: a header line `path:start-end kind qualified.name`, then the lines
`start..=end` formatted `{n:>6}\t{line}` (Read's format). The range includes
leading doc comments and attributes/decorators.

Matching: split `symbol` on `::` or `.`; a symbol matches when its qualified path
(container names + own name) ends with those segments, compared case-sensitively.
If none match exactly, there is no case-insensitive fallback; the not-found message suggests names.

## Architecture

### Repo layout

```
plugins/code-outline/
  .claude-plugin/plugin.json
  .mcp.json                       command: ${CLAUDE_PLUGIN_ROOT}/bin/code-outline.exe
  bin/code-outline.exe            committed prebuilt binary
crates/code-outline/
  Cargo.toml
  queries/{rust,typescript,javascript,python,csharp}.scm
  src/
    lib.rs       pub mod lang; extract; resolve; files; format; pipeline; server;
    main.rs      tokio main → server::run()
    lang.rs
    extract.rs
    resolve.rs
    files.rs
    format.rs
    pipeline.rs
    server.rs
  tests/
    fixtures/sample.{rs,ts,tsx,js,py,cs}
    languages.rs   one exact-outline test per fixture
    protocol.rs    spawns the exe, MCP handshake, calls both tools
justfile                          `just release code-outline` (generic per plugin, no change)
.claude-plugin/marketplace.json   gains a code-outline entry
```

The TSX grammar reuses `typescript.scm`; the query is compiled once per `Lang`.

### Units

- **`lang.rs`**: `enum Lang { Rust, TypeScript, Tsx, JavaScript, Python, CSharp }`
  with `from_path(&Path) -> Option<Lang>`, `grammar() -> tree_sitter::Language`,
  `query() -> &'static Query` (compiled lazily from `include_str!`, cached in a
  `OnceLock`), and `leading_kinds() -> &[&str]`. The only module that knows which
  languages exist.
- **`queries/*.scm`**: each definition pattern captures the whole node as
  `@item.<kind>` (e.g. `@item.fn`, `@item.class`) and its identifier as `@name`.
  The capture suffix is the kind label shown in the outline.
- **`extract.rs`**: `extract(source: &str, lang: Lang) -> Extracted { symbols: Vec<Symbol>, error_lines: Vec<usize> }`.
  `Symbol { kind, name, start_line, end_line, start_byte, end_byte, signature, children }`.
  Steps: parse; run the query; build the tree by range containment (sort by start
  byte, then by length descending, push onto a stack); extend each range upward
  over leading docs/attributes; compute signature; apply the Rust `impl` naming
  hook; collect the first 3 lines that contain `ERROR`/`MISSING` nodes.
  - **Leading docs/attributes**: walk previous named siblings while their kind is
    in `leading_kinds` and there is no blank line between them and the item.
    Rust: `attribute_item`, `line_comment`, `block_comment` (doc form only: `///`,
    `//!`, `/**`). TS/JS: `comment` starting with `/**`. C#: `comment` starting
    with `///` (attributes are already children of the declaration). Python:
    when the item's parent is `decorated_definition`, the parent becomes the item
    node; docstrings are inside the body already.
  - **Signature**: source from the item's start (after leading docs/attributes) to
    the start of its `body` field child, whitespace collapsed to single spaces,
    trailing `{`/`:` trimmed, capped at 160 chars with `…`. Items without a body
    use their first line, same treatment.
  - **Rust `impl` naming**: name = `Type` or `Trait for Type` with generic
    arguments removed; outline label `impl <name>`. For qualified lookup the
    container segment is `Type`, so `Foo::fmt` resolves inside `impl Display for Foo`.
- **`resolve.rs`**: `resolve(&[Symbol], query: &str, line: Option<usize>) -> Resolution`
  where `Resolution = Found(&Symbol, qualified) | Ambiguous(Vec<(…)>) | NotFound(Vec<String>)`.
  Suggestions: case-insensitive substring matches first, then Levenshtein
  distance ≤ 3 (hand-written, no dependency), at most 5.
- **`files.rs`**: `repo_root()` (`CLAUDE_PROJECT_DIR` if set and exists, else
  cwd; canonicalised with `dunce`, matching everything-find's fix) and
  `expand(root, patterns, limit) -> Expanded { files, hidden_by_gitignore, unsupported, total }`.
  Literal paths are taken as-is; patterns with glob metacharacters walk the
  root with `ignore::WalkBuilder` and match with `globset`. Root-prefix
  comparison is case-insensitive.
- **`format.rs`**: pure functions `outline(files: &[FileOutline], opts) -> String`
  and `numbered(source, start, end) -> String`. Knows nothing about tree-sitter.
- **`pipeline.rs`**: `run_outline(&OutlineParams, &Context) -> Result<String, String>`
  and `run_read_symbol(&ReadSymbolParams, &Context) -> Result<String, String>`.
  `Ok` = tool text (including the soft error messages below); `Err` = invalid params.
- **`server.rs`**: `rmcp` stdio server registering both tools; each call runs the
  pipeline in `spawn_blocking`. Same shape as everything-find's `server.rs`.

Root resolution is copied from everything-find (~20 lines) instead of creating a
shared crate; extract one when a third plugin needs it.

### Data flow

**outline**: root → `files::expand` → for each file: `Lang::from_path`, read
(skip if > 2 MB), strip BOM, decode (lossy if not UTF-8) → `extract` →
`format::outline`. Output stops at a file boundary once it passes 2,000 lines;
the header then says how many files were omitted.

**read_symbol**: resolve `path` against the root → read → `extract` → `resolve`
→ `format::numbered(source, start_line, end_line)`.

Line counting splits on `\n`; a trailing `\r` is stripped from each line in output.

## Error handling

Every failure is a normal text tool result telling Claude what to do next. The
server never panics on bad input.

| Situation | Message |
|---|---|
| File not found | `<path> not found.` |
| Unsupported extension (named explicitly) | `code-outline doesn't support .<ext> files — use Read.` |
| Glob matched nothing | `0 files match <pattern> in <root>`, plus ` (N hidden by .gitignore)` when N > 0 |
| Glob matched only unsupported files | `<N> files matched but none are supported (rs, ts, tsx, js, jsx, mjs, cjs, py, cs) — use Read.` |
| File > 2 MB | `<path> is <size>, over the 2 MB limit — use Read with offset/limit.` |
| Not valid UTF-8 | Decode lossily; append `(file is not valid UTF-8; some characters replaced)` |
| No symbols | `<path> (N lines): no symbols found` |
| Syntax errors | Normal output plus `(syntax errors near lines a, b, c — outline may be incomplete)` |
| `read_symbol` ambiguous | `<symbol> matches N symbols — pass line:` then one `kind qualified.name start-end` per line |
| `read_symbol` not found | `No symbol <symbol> in <path>. Closest: a, b, c` (or `No symbol <symbol> in <path>.` with no suggestions) |
| Output truncated | Header `showing X of Y files (output limit) — narrow paths` |
| More files matched than `limit` | Header `showing X of Y files (limit)` |
| Invalid params (limit out of range, empty `symbol`, empty `paths`) | MCP invalid-params error naming the field |

In multi-file outlines, per-file problems (too large, not found) appear as a single
line in that file's place; the rest of the output is unaffected.

## Testing

- **Language fixtures** (`tests/languages.rs`): one fixture per grammar exercising
  its quirks — Rust `impl<T> Trait for Type<T>`, `#[cfg(test)] mod tests`, attributes
  and `///` docs; TS arrow-function consts, JSDoc, nested classes, interfaces, enums;
  TSX component; Python decorators, nested class, async def, docstrings; C# namespace,
  record, properties, attributes, `///` docs. Each test asserts the exact outline text
  (expected output inline as a string literal).
- **Unit tests**:
  - `extract.rs`: leading docs/attributes stop at a blank line; signature cut at body
    and capped; Python `decorated_definition`; half-written file still yields symbols
    and reports error lines.
  - `resolve.rs`: plain name, `.` and `::` qualified, Rust impl container, ambiguous
    without/with `line`, not-found suggestions.
  - `files.rs`: literal vs glob, `.gitignore` hiding and count, unsupported files skipped
    and counted, root casing differences, relative paths with `..`.
  - `format.rs`: numbering matches Read (`{n:>6}\t`), CRLF stripped, truncation header,
    nesting indentation.
- **Protocol test** (`tests/protocol.rs`, like everything-find): spawn the exe, MCP
  handshake, `tools/list` shows both tools, call each on a fixture.
- **Manual end-to-end**: install from the local marketplace and ask Claude to show
  `FindServer::find` in `crates/everything-find`; confirm it uses `outline` /
  `read_symbol` instead of Read. Record the release exe size and the `crates/**/*.rs`
  timing in this spec.

## Distribution

`just release code-outline` (root `justfile`, generic per plugin) builds and
copies `code-outline.exe` into `plugins/code-outline/bin/`. Binary committed, as with
everything-find.

## Dependencies

- `tree-sitter` 0.27; `tree-sitter-rust`, `-typescript`, `-javascript`, `-python`, `-c-sharp`
- `rmcp` 3.5.1 (`server`, `macros`, `transport-io`), `tokio`, `serde`, `schemars`, `anyhow`
- `ignore` 0.4, `globset`, `dunce`
- dev: `tempfile`, `serde_json`

The first implementation task confirms the grammar crates link against
`tree-sitter` 0.27 (shared `tree-sitter-language` ABI) and records the exe size.
