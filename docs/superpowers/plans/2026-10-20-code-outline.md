# code-outline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Claude Code plugin whose Rust MCP server exposes `outline` (symbols with line ranges) and `read_symbol` (one symbol's source, Read-style numbered) for Rust, TS/TSX, JS, Python and C#.

**Architecture:** One workspace crate `code-outline` (lib + thin bin). `lang` is the language table; per-language tree-sitter queries in `queries/*.scm` feed `extract`, which builds a nested `Symbol` tree. `resolve` looks a symbol up, `files` expands paths/globs under the repo root, `format` renders text, `pipeline` wires them without rmcp, `server` wraps the pipeline in an `rmcp` stdio server.

**Tech Stack:** Rust 2024 (stable-x86_64-pc-windows-msvc), tree-sitter 0.27, tree-sitter-rust 0.24, tree-sitter-typescript 0.23, tree-sitter-javascript 0.25, tree-sitter-python 0.25, tree-sitter-c-sharp 0.23, rmcp 3.5.1 (`server`, `macros`, `transport-io`), tokio, serde, schemars 1, ignore 0.4, globset, dunce, anyhow.

**Spec:** `docs/superpowers/specs/2026-10-20-code-outline-design.md`

**Refinements to the spec (decided here):**
- Query capture names can't contain spaces, so `@item.async_def` is shown as `async def` (underscore → space in the label).
- A symbol whose name equals its kind (TS `constructor`) prints the kind once: `constructor 18-30`.
- Rust `//!` comments are inner docs (they document the enclosing module), so they are **not** attached to the following item. Rust doc prefixes are `///` and `/**`.
- Attributes/decorators that are *children* of the definition node (C# `attribute_list`, TS `decorator`) are part of the range already; the signature starts at the first child that is not one of them.
- A single file whose outline alone exceeds the 2,000-line output cap is cut at 2,000 lines with `(outline truncated — narrow with read_symbol)`; otherwise the cap still cuts at file boundaries.
- Backslashes in `paths` are normalised to `/` before glob matching (Windows paths; globset escapes are not needed).

## Global Constraints

- One crate `crates/code-outline`, lib name `code_outline`, bin `code-outline`. No shared crate with everything-find; copy `Context`/`repo_root`.
- Grammars compiled in statically; no runtime downloads, no DLLs, no network at build time beyond crates.io.
- Extensions: `rs`; `ts mts cts`; `tsx`; `js jsx mjs cjs`; `py pyi`; `cs`. Matched case-insensitively.
- File size limit 2 MB (`2 * 1024 * 1024` bytes). Outline output cap 2,000 lines. Signature cap 160 chars (+ `…`). Up to 3 syntax-error lines reported. Up to 5 suggestions, Levenshtein ≤ 3.
- `outline` params: `paths` (string or string[], required), `signatures` = `false`, `limit` 1–500 = `50`. `read_symbol` params: `path` (required), `symbol` (required), `line` (optional, 1-based).
- Line ranges 1-based inclusive. Read-style numbering `{n:>6}\t{line}`; trailing `\r` stripped.
- Tool descriptions, verbatim:
  - `outline`: `List the symbols (functions, classes, methods…) in source files with line ranges, without reading the bodies. Rust, TS/JS, Python, C#. Use before Read to find what you need, then read_symbol.`
  - `read_symbol`: `Read one symbol's source (with its doc comments and attributes) from a file, line-numbered like Read. symbol is a name or qualified path: ApiClient.get, FindServer::find.`
- Message copy, verbatim (placeholders in `<>`):
  - `<path> not found.`
  - `code-outline doesn't support .<ext> files — use Read.`
  - `0 files match <pattern> in <root>` + ` (N hidden by .gitignore)` when N > 0
  - `<N> files matched but none are supported (rs, ts, tsx, js, jsx, mjs, cjs, py, cs) — use Read.`
  - `<path> is <size>, over the 2 MB limit — use Read with offset/limit.` (size like `3.4 MB`)
  - `(file is not valid UTF-8; some characters replaced)`
  - `<path> (N lines): no symbols found`
  - `(syntax errors near lines a, b, c — outline may be incomplete)`
  - `<symbol> matches N symbols — pass line:` then lines `kind qualified.name start-end`
  - `No symbol <symbol> in <path>. Closest: a, b, c` / `No symbol <symbol> in <path>.`
  - `showing X of Y files (output limit) — narrow paths` / `showing X of Y files (limit)`
- The server never panics on bad input. Invalid params → MCP invalid-params error naming the field.

## Review Focus

1. **CRLF files** (most Windows checkouts): line ranges match Read's numbering and no `\r` leaks into signatures or numbered output. Test in Task 2 and Task 7.
2. **Non-ASCII source** (`fn đorđe()`, emoji in string literals before a symbol): line numbers stay right and the 160-char signature cap cuts on a char boundary, never panics. Test in Task 2.
3. **Windows-style paths from Claude** (`crates\everything-find\src\*.rs`, `C:/Source/...`, different casing from the root): resolve and display relative to the root. Test in Task 6.
4. **Overloads and same-name pairs** (C# method overloads, TS overload signatures, Python `@property` getter + `@x.setter`): `read_symbol` reports Ambiguous and `line` picks the right one. Test in Task 5 (and fixtures in Tasks 3–4).
5. **BOM-prefixed files** (C# from Visual Studio): first symbol's line range and numbered text are unaffected. Test in Task 8.

---

## File Structure

```
Cargo.toml                                    workspace (unchanged: members = ["crates/*"])
.claude-plugin/marketplace.json               + code-outline entry
scripts/release.ps1                           builds/copies both plugins
plugins/code-outline/.claude-plugin/plugin.json
plugins/code-outline/.mcp.json
plugins/code-outline/bin/code-outline.exe     (built, committed)
crates/code-outline/
  Cargo.toml
  queries/{rust,typescript,javascript,python,csharp}.scm
  src/lib.rs        pub mod lang; extract; resolve; files; format; pipeline; server;
  src/main.rs       tokio main → server::run()
  src/lang.rs       Lang table
  src/extract.rs    Symbol tree from source
  src/resolve.rs    symbol lookup + suggestions
  src/files.rs      Context, repo_root, path/glob expansion
  src/format.rs     outline text, numbered lines
  src/pipeline.rs   params, run_outline, run_read_symbol
  src/server.rs     rmcp server
  tests/fixtures/sample.{rs,ts,tsx,js,py,cs}
  tests/languages.rs
  tests/protocol.rs
```

---

### Task 1: Crate scaffold and language table

**Files:**
- Create: `crates/code-outline/Cargo.toml`, `src/lib.rs`, `src/main.rs` (placeholder `fn main() {}` until Task 9), `src/lang.rs`, empty `queries/*.scm` (one comment line each)

**Interfaces:**
- Produces:
  - `#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)] pub enum Lang { Rust, TypeScript, Tsx, JavaScript, Python, CSharp }`
  - `Lang::from_path(&Path) -> Option<Lang>` (extension, case-insensitive)
  - `Lang::grammar(self) -> tree_sitter::Language`
  - `Lang::query(self) -> &'static tree_sitter::Query` — compiled from `include_str!("../queries/<x>.scm")` once per `Lang` (`OnceLock`); TS and TSX share `typescript.scm` but compile separately (different grammars). Panics on an invalid query (a build bug, caught by tests).
  - `Lang::doc_prefixes(self) -> &'static [&'static str]` — Rust `["///", "/**"]`, TS/TSX/JS `["/**"]`, C# `["///"]`, Python `[]`
  - `Lang::attr_kinds(self) -> &'static [&'static str]` — Rust `["attribute_item"]`, TS/TSX/JS `["decorator"]`, C# `["attribute_list"]`, Python `[]`
  - `Lang::comment_kinds(self) -> &'static [&'static str]` — Rust `["line_comment", "block_comment"]`, others `["comment"]`
  - `Lang::sep(self) -> &'static str` — Rust `"::"`, others `"."`
  - `pub const SUPPORTED: &str = "rs, ts, tsx, js, jsx, mjs, cjs, py, cs";`

- [ ] **Step 1: Write `Cargo.toml`** mirroring `crates/everything-find/Cargo.toml` (edition 2024, `[lib] name = "code_outline"`, `[[bin]] name = "code-outline"`), with the Tech Stack dependencies plus dev-deps `tempfile = "3"`, `serde_json = "1"`. No build.rs.
- [ ] **Step 2: Write failing tests** in `lang.rs`:

```rust
#[test] fn ext_mapping() {
    assert_eq!(Lang::from_path(Path::new("a/b.RS")), Some(Lang::Rust));
    assert_eq!(Lang::from_path(Path::new("x.mts")), Some(Lang::TypeScript));
    assert_eq!(Lang::from_path(Path::new("x.tsx")), Some(Lang::Tsx));
    assert_eq!(Lang::from_path(Path::new("x.cjs")), Some(Lang::JavaScript));
    assert_eq!(Lang::from_path(Path::new("x.pyi")), Some(Lang::Python));
    assert_eq!(Lang::from_path(Path::new("x.cs")), Some(Lang::CSharp));
    assert_eq!(Lang::from_path(Path::new("x.go")), None);
    assert_eq!(Lang::from_path(Path::new("Makefile")), None);
}
#[test] fn every_grammar_parses() { /* for each Lang: tree_sitter::Parser::set_language(&l.grammar()) ok, parse a one-line snippet, !root.has_error() */ }
#[test] fn every_query_compiles() { for l in ALL { let _ = l.query(); } }
```

- [ ] **Step 3: Run** `cargo test -p code-outline lang`. Expected: FAIL (not implemented).
- [ ] **Step 4: Implement `lang.rs`.** Confirm against docs.rs how tree-sitter 0.27 turns a grammar crate's `LanguageFn` into a `Language` (`LANGUAGE.into()`). If any grammar crate fails to link against 0.27 (mismatched `tree-sitter-language`), stop and report the version conflict rather than downgrading silently.
- [ ] **Step 5: Run** `cargo test -p code-outline lang`. Expected: PASS. Note the clean-build time of the C# grammar in the commit message body.
- [ ] **Step 6: Commit** `git add crates/code-outline Cargo.lock && git commit -m "feat(code-outline): crate scaffold and language table"`

---

### Task 2: Symbol extraction (Rust query first)

**Files:**
- Create: `crates/code-outline/src/extract.rs` (tests inline)
- Modify: `crates/code-outline/queries/rust.scm`

**Interfaces:**
- Consumes: `Lang` (Task 1)
- Produces:
  - `#[derive(Debug, Clone, PartialEq)] pub struct Symbol { pub kind: String, pub name: String, pub key: String, pub start_line: usize, pub end_line: usize, pub signature: String, pub children: Vec<Symbol> }` — `kind` is the label (`fn`, `async def`); `name` is what the outline shows; `key` is the qualified-path segment (equals `name` except Rust impls); lines are 1-based inclusive and include leading docs/attributes.
  - `pub struct Extracted { pub symbols: Vec<Symbol>, pub error_lines: Vec<usize> }`
  - `pub fn extract(source: &str, lang: Lang) -> Extracted`
  - `impl Symbol { pub fn label(&self) -> String }` — `"{kind} {name}"`, or just `kind` when `name == kind`

**Query convention:** each pattern captures the definition node as `@item.<kind>` and its identifier as `@name`. Rust patterns: `function_item`, `function_signature_item` → `fn`; `struct_item`, `enum_item`, `trait_item`, `mod_item`, `type_item`, `const_item`, `static_item` → their keyword; `macro_definition` → `macro`; `impl_item` → `impl` (capture `type` field as `@name`; the hook below computes the real name).

**Algorithm (in this order):**
1. Parse; run `lang.query()` with a `QueryCursor`; for each match take the `@item.*` node and `@name` text. Python: if the item's parent is `decorated_definition`, use the parent as the range node. Skip duplicate nodes (same byte range).
2. **Range start:** walk `prev_named_sibling()` of the range node while the sibling is in `attr_kinds`, or in `comment_kinds` with text starting with a `doc_prefixes` entry, **and** the sibling's end row ≥ current start row − 1 (no blank line between). The first line of the last accepted sibling is `start_line`.
3. **Signature:** take the definition node (inner node for Python); start at its first child not in `attr_kinds`/`comment_kinds`; end at the start byte of the first node in a pre-order walk of the definition that is the `body` field child of its parent; if none, end at the end of the definition's first line. Collapse whitespace runs to one space, trim, strip one trailing `{` or `:`, trim again, cap at 160 **chars** with `…`.
4. **Rust impl hook:** for `impl_item`, `key` = `type` field text with generic arguments removed (strip from the first `<`); `name` = `key`, or `"{Trait} for {key}"` when the `trait` field exists (trait also stripped of generics).
5. **Nesting:** sort by (start byte asc, end byte desc); keep a stack; pop while the top's end byte ≤ current start byte; push as a child of the top (or root). Use the definition node's byte range for containment, not the doc-extended range.
6. **Error lines:** if `root.has_error()`, walk the tree and collect the 1-based start rows of `is_error()` / `is_missing()` nodes, deduplicated, ascending, first 3.

- [ ] **Step 1: Write `queries/rust.scm`.** Start from `tree_sitter_rust::TAGS_QUERY` and reshape to the convention above.
- [ ] **Step 2: Write failing tests** in `extract.rs` using Rust snippets:

```rust
#[test] fn nests_impl_methods() { /* impl Foo { fn a(){} fn b(){} } */ assert_eq!(tree(&x), "impl Foo 1-4\n  fn a 2-2\n  fn b 3-3"); }
#[test] fn impl_trait_for_generic() { /* impl<T: Clone> Display for Wrap<T> { fn fmt.. } */ assert_eq!(s.name, "Display for Wrap"); assert_eq!(s.key, "Wrap"); assert_eq!(s.label(), "impl Display for Wrap"); }
#[test] fn docs_and_attrs_extend_range() { /* line1 "/// doc", line2 "#[test]", line3 "fn t() {}" */ assert_eq!((s.start_line, s.end_line), (1, 3)); }
#[test] fn blank_line_stops_doc_walk() { /* "/// orphan", "", "fn f() {}" */ assert_eq!(s.start_line, 3); }
#[test] fn inner_doc_not_attached() { /* "//! module docs", "fn f() {}" */ assert_eq!(s.start_line, 2); }
#[test] fn plain_comment_not_attached() { /* "// note", "fn f() {}" */ assert_eq!(s.start_line, 2); }
#[test] fn signature_cut_at_body() { assert_eq!(s.signature, "pub async fn find(&self, p: Params) -> Result<String, E>"); /* source spans 3 lines before `{` */ }
#[test] fn signature_capped_on_char_boundary() { /* fn with 200-char param list of 'đ' identifiers */ assert_eq!(s.signature.chars().count(), 161); assert!(s.signature.ends_with('…')); }
#[test] fn crlf_lines() { /* same nests_impl_methods source with \r\n */ assert_eq!(tree(&x), "impl Foo 1-4\n  fn a 2-2\n  fn b 3-3"); assert!(!s.signature.contains('\r')); }
#[test] fn non_ascii_before_symbol() { /* line1: let s = "😀 đ"; inside fn a, line3: fn b() {} */ assert_eq!(b.start_line, 3); }
#[test] fn broken_file_still_outlines() { /* "fn ok() {}\nfn broken( {\nstruct S;" */ assert!(names.contains("ok") && names.contains("S")); assert_eq!(x.error_lines.first(), Some(&2)); }
#[test] fn kinds() { /* one of each Rust kind */ assert_eq!(kinds, ["fn","struct","enum","trait","impl","mod","macro","type","const","static"]); }
#[test] fn test_module_nesting() { /* #[cfg(test)] mod tests { #[test] fn t() {} } */ assert_eq!(tree(&x), "mod tests 1-4\n  fn t 3-3"); }
```

(`tree(&x)` is a test helper rendering `label start-end` with two-space indents.)

- [ ] **Step 3: Run** `cargo test -p code-outline extract`. Expected: FAIL.
- [ ] **Step 4: Implement `extract`** per the algorithm.
- [ ] **Step 5: Run** `cargo test -p code-outline extract`. Expected: PASS.
- [ ] **Step 6: Commit** `git commit -m "feat(code-outline): symbol extraction with Rust query"`

---

### Task 3: TypeScript, TSX and JavaScript queries

**Files:**
- Modify: `crates/code-outline/queries/typescript.scm`, `queries/javascript.scm`
- Create: `crates/code-outline/tests/fixtures/sample.ts`, `sample.tsx`, `sample.js`, `crates/code-outline/tests/languages.rs`

**Interfaces:**
- Consumes: `extract`, `Symbol::label` (Task 2)
- Produces: `tests/languages.rs` with a helper `fn outline_of(fixture: &str) -> String` (reads the fixture, `extract`, renders `label start-end` with two-space indents, one symbol per line). Task 4 adds to this file.

**Kinds:** `function_declaration`, `generator_function_declaration` → `function`; `class_declaration`, `abstract_class_declaration` (TS) → `class`; `method_definition` → `method`, except name `constructor` → `@item.constructor`; TS: `interface_declaration` → `interface`, `type_alias_declaration` → `type`, `enum_declaration` → `enum`, `internal_module`/`module` → `namespace`, `method_signature` / `function_signature` (overloads) → `method` / `function`; `lexical_declaration`/`variable_declaration` whose declarator value is `arrow_function` or `function_expression` → `function` (name from the declarator). `export_statement` wrappers: the item is the inner declaration, but its doc comment precedes the `export_statement` — when the definition's parent is `export_statement`, walk siblings from the parent.

- [ ] **Step 1: Write fixtures.**
  - `sample.ts`: a JSDoc'd `interface ClientOptions`, `type Id = string`, `enum Color`, `namespace Util { export function helper() {} }`, an `export class ApiClient` with a constructor, a JSDoc'd method `get`, a decorated method `post` (`@log`), an overloaded method `put` (two signatures + implementation), `export const createClient = (o: ClientOptions) => new ApiClient(o);`, and a nested class inside a function.
  - `sample.tsx`: `export function Button(props: Props) { return <button/>; }` and `const Card = () => <div/>;`.
  - `sample.js`: a function, a class with methods, a `const handler = async () => {}`, and a `module.exports.run = function () {}` assignment, which is **not** an outline item.
- [ ] **Step 2: Write failing tests** in `tests/languages.rs`, one per fixture, each asserting the exact `outline_of(...)` string (write the expected string by hand from the fixture; doc comments and decorators fold into ranges; `put` appears three times as `method put`).
- [ ] **Step 3: Run** `cargo test -p code-outline --test languages`. Expected: FAIL.
- [ ] **Step 4: Write the two queries** (start from each crate's `TAGS_QUERY`; TS query must include the JS patterns since the TS grammar extends JS) and add the `export_statement` sibling rule to `extract`.
- [ ] **Step 5: Run** `cargo test -p code-outline`. Expected: PASS (Task 2 tests included).
- [ ] **Step 6: Commit** `git commit -m "feat(code-outline): TypeScript, TSX and JavaScript outlines"`

---

### Task 4: Python and C# queries

**Files:**
- Modify: `crates/code-outline/queries/python.scm`, `queries/csharp.scm`, `tests/languages.rs`
- Create: `tests/fixtures/sample.py`, `tests/fixtures/sample.cs`

**Interfaces:**
- Consumes: `outline_of` (Task 3), `extract` (Task 2)

**Kinds:** Python `class_definition` → `class`; `function_definition` → `def`, or `async_def` when it has an `async` child. C# `namespace_declaration`, `file_scoped_namespace_declaration` → `namespace`; `class_declaration`, `struct_declaration`, `record_declaration` (and `record_struct_declaration` if present in the grammar), `interface_declaration`, `enum_declaration` → their keyword; `method_declaration` → `method`; `constructor_declaration` → `constructor`; `property_declaration` → `property`.

- [ ] **Step 1: Write fixtures.**
  - `sample.py`: module docstring, `@dataclass class Point` with a method, a class with `@property def x` + `@x.setter def x`, `async def fetch()`, a nested `def inner()` inside a function, a decorator spanning two lines (`@app.route(\n "/x")`).
  - `sample.cs`: file-scoped `namespace Demo;`, `/// <summary>` docs on a class, `[Serializable]` attribute, a constructor, two overloads of `Add`, a property `Name { get; set; }`, a `record Person(string Name)`, a `struct`, an `interface`, an `enum`, a nested class.
- [ ] **Step 2: Write failing tests** in `tests/languages.rs`: exact `outline_of` strings for both fixtures, plus

```rust
#[test] fn python_decorator_in_range() { /* @dataclass line is the class start_line */ }
#[test] fn csharp_signature_skips_attributes() { assert_eq!(cls.signature, "public class Store"); }
```

- [ ] **Step 3: Run** `cargo test -p code-outline --test languages`. Expected: FAIL.
- [ ] **Step 4: Write the two queries.** Check node names against each grammar's `NODE_TYPES` (the C# grammar names change between versions).
- [ ] **Step 5: Run** `cargo test -p code-outline`. Expected: PASS.
- [ ] **Step 6: Commit** `git commit -m "feat(code-outline): Python and C# outlines"`

---

### Task 5: Symbol resolution

**Files:**
- Create: `crates/code-outline/src/resolve.rs` (tests inline)

**Interfaces:**
- Consumes: `Symbol` (Task 2), `Lang::sep` (Task 1)
- Produces:
  - `pub struct Hit<'a> { pub symbol: &'a Symbol, pub qualified: String }` — `qualified` = container keys + own key joined with `lang.sep()`
  - `pub enum Resolution<'a> { Found(Hit<'a>), Ambiguous(Vec<Hit<'a>>), NotFound(Vec<String>) }`
  - `pub fn resolve<'a>(symbols: &'a [Symbol], lang: Lang, query: &str, line: Option<usize>) -> Resolution<'a>`

**Rules:** split `query` on `::` and `.` into segments; each symbol's path = all ancestor keys + own key, each key also split on `.` (C# `namespace A.B`); match when the path ends with the query segments (case-sensitive). With `line`, keep only hits whose range contains it; if several still remain, pick the innermost (shortest range). One hit → Found; several → Ambiguous (document order); none → NotFound with suggestions: qualified names whose last key contains the query's last segment case-insensitively, then those with Levenshtein ≤ 3 to it, deduplicated, at most 5. Levenshtein is a small hand-written function in this file.

- [ ] **Step 1: Write failing tests** (build `Symbol` trees with a small helper, or `extract` real snippets):

```rust
#[test] fn plain_name() { assert!(matches!(r("find"), Found(h) if h.qualified == "FindServer::find")); }
#[test] fn qualified_colons_and_dots() { assert!(found(r("FindServer::find"))); assert!(found(r("FindServer.find"))); }
#[test] fn impl_trait_container_is_type() { /* impl Display for Foo { fn fmt } */ assert!(matches!(r("Foo::fmt"), Found(_))); }
#[test] fn csharp_dotted_namespace() { /* namespace A.B { class C { void M() } } */ assert!(found(r("B.C.M"))); }
#[test] fn ambiguous_overloads() { /* two C# Add methods lines 5-7 and 9-11 */ assert!(matches!(r("Add"), Ambiguous(v) if v.len() == 2)); }
#[test] fn line_disambiguates() { assert!(matches!(r_line("Add", 10), Found(h) if h.symbol.start_line == 9)); }
#[test] fn python_property_pair() { /* @property x / @x.setter x */ assert!(matches!(r("x"), Ambiguous(v) if v.len() == 2)); }
#[test] fn case_sensitive() { assert!(matches!(r("findserver::find"), NotFound(_))); }
#[test] fn suggestions() { assert!(matches!(r("fnd"), NotFound(s) if s == ["FindServer::find"])); }
#[test] fn suggestions_capped_at_five() { /* 8 symbols named get_a..get_h */ assert_eq!(nf(r("get")).len(), 5); }
```

- [ ] **Step 2: Run** `cargo test -p code-outline resolve`. Expected: FAIL.
- [ ] **Step 3: Implement `resolve`.**
- [ ] **Step 4: Run** `cargo test -p code-outline resolve`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(code-outline): symbol resolution with suggestions"`

---

### Task 6: Repo root and path/glob expansion

**Files:**
- Create: `crates/code-outline/src/files.rs` (tests inline)

**Interfaces:**
- Consumes: `Lang::from_path` (Task 1)
- Produces:
  - `#[derive(Clone)] pub struct Context { pub cwd: PathBuf, pub project_dir: Option<PathBuf> }` with `Context::from_env()` — same as everything-find's `pipeline.rs:92`
  - `pub fn repo_root(ctx: &Context) -> PathBuf` — `project_dir` if `Some` and exists, else `cwd`; `dunce::canonicalize`, falling back to the raw path
  - `pub fn resolve_file(root: &Path, path: &str) -> PathBuf` — absolute as-is, relative joined to root, then `dunce::canonicalize` (falling back to the joined path)
  - `pub fn display(root: &Path, path: &Path) -> String` — relative with `/` separators when under root (case-insensitive prefix, copy `strip_root_ci` from `everything-find/src/filter.rs`), else absolute
  - `pub enum Entry { File(PathBuf, Lang), Missing(String), Unsupported(String, String /*ext*/) }`
  - `pub struct Expanded { pub entries: Vec<Entry>, pub total: usize, pub empty_patterns: Vec<(String, usize /*hidden by gitignore*/)>, pub unsupported_only: usize }`
  - `pub fn expand(root: &Path, patterns: &[String], limit: usize) -> Expanded`

**Rules:**
- Normalise `\` to `/` in each pattern. A pattern without `* ? [ {` is literal: missing → `Missing(pattern)`; no supported extension → `Unsupported(pattern, ext)`; else `File`.
- Glob: base dir = the longest leading run of path components with no metacharacter, resolved like `resolve_file`; remaining components are the glob, matched with `globset::GlobBuilder::literal_separator(true)` against the path relative to base (with `/`). Walk base with `ignore::WalkBuilder` (`hidden(false)`, `require_git(false)`, `parents(true)`, skip `.git`). Unsupported matches are counted, not listed.
- A glob with zero supported matches: if it matched unsupported files, add to `unsupported_only`; otherwise push `(pattern, hidden)` to `empty_patterns`, where `hidden` comes from a second walk with `standard_filters(false)` (only run in this case).
- Deduplicate by canonical path, sort by `display`, `total` = count, keep the first `limit`.

- [ ] **Step 1: Write failing tests** (tempdir canonicalised with `dunce`, with `.gitignore` = `build/\n`, files `src/a.rs`, `src/b.ts`, `src/c.go`, `src/deep/d.py`, `build/gen.rs`, `My Dir/e.cs`):

```rust
#[test] fn glob_respects_gitignore() { assert_eq!(names(expand(&root, &["**/*.rs".into()], 50)), ["src/a.rs"]); }
#[test] fn double_star_and_braces() { assert_eq!(names(ex("src/**/*.{ts,py}")), ["src/b.ts", "src/deep/d.py"]); }
#[test] fn star_does_not_cross_dirs() { assert_eq!(names(ex("src/*.py")), Vec::<String>::new()); }
#[test] fn backslash_pattern() { assert_eq!(names(ex(r"src\*.rs")), ["src/a.rs"]); }
#[test] fn absolute_pattern_other_casing() { /* root uppercased + "/src/*.rs" */ assert_eq!(names(..), ["src/a.rs"]); }
#[test] fn space_in_dir() { assert_eq!(names(ex("My Dir/*.cs")), ["My Dir/e.cs"]); }
#[test] fn literal_missing_and_unsupported() { /* "nope.rs", "src/c.go" */ assert!(matches!(e[0], Missing(_)) && matches!(&e[1], Unsupported(_, x) if x == "go")); }
#[test] fn empty_glob_counts_hidden() { assert_eq!(ex("build/*.rs").empty_patterns, [("build/*.rs".into(), 1)]); }
#[test] fn only_unsupported() { assert_eq!(ex("src/*.go").unsupported_only, 1); }
#[test] fn limit_and_total() { let x = expand(&root, &["**/*".into()], 2); assert_eq!((x.entries.len(), x.total), (2, 4)); }
#[test] fn dotdot_relative() { assert_eq!(resolve_file(&root, "src/../src/a.rs"), root.join("src").join("a.rs")); }
#[test] fn project_dir_preferred() { /* as everything-find */ }
```

- [ ] **Step 2: Run** `cargo test -p code-outline files`. Expected: FAIL.
- [ ] **Step 3: Implement** as specified.
- [ ] **Step 4: Run** `cargo test -p code-outline files`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(code-outline): repo root and path/glob expansion"`

---

### Task 7: Output formatting

**Files:**
- Create: `crates/code-outline/src/format.rs` (tests inline)

**Interfaces:**
- Consumes: `Symbol`, `Symbol::label` (Task 2)
- Produces:
  - `pub enum FileOutline { Symbols { display: String, line_count: usize, symbols: Vec<Symbol>, notes: Vec<String> }, Message(String) }`
  - `pub fn outline(files: &[FileOutline], total: usize, limit_hit: bool, signatures: bool) -> String`
  - `pub fn numbered(source: &str, start: usize, end: usize) -> String`
  - `pub fn human_size(bytes: u64) -> String` — one decimal, `KB`/`MB` (`3.4 MB`)

**Rules:**
- Per file: `"{display} ({line_count} lines)"`, then each symbol `"{indent}{text} {start}-{end}"`, two spaces per depth starting at 2, `text` = `label()` or, with `signatures`, `signature` (for Rust impls keep `label()`; an empty signature falls back to `label()`). Then `notes`, each on its own line. No symbols and no notes → `"{display} ({n} lines): no symbols found"`. `Message` renders as its text. Files separated by one blank line.
- Cap: count output lines; before adding a file that would push past 2,000, stop and prepend header `showing X of Y files (output limit) — narrow paths` (Y = `total`). If the *first* file alone is over 2,000, emit its first 2,000 lines then `(outline truncated — narrow with read_symbol)`. Otherwise, when `limit_hit`, prepend `showing X of Y files (limit)`.
- `numbered`: split `source` on `\n`, strip one trailing `\r` per line, emit lines `start..=end` as `format!("{n:>6}\t{line}")`, joined with `\n`.

- [ ] **Step 1: Write failing tests:**

```rust
#[test] fn nested_indent() { assert_eq!(outline(&[file()], 1, false, false), "src/server.rs (52 lines)\n  struct FindServer 9-12\n  impl FindServer 14-30\n    fn new 15-17"); }
#[test] fn signatures_mode() { assert!(out.contains("    pub fn new() -> Self 15-17") && out.contains("  impl FindServer 14-30")); }
#[test] fn no_symbols() { assert_eq!(out, "a.py (3 lines): no symbols found"); }
#[test] fn notes_after_symbols() { assert!(out.ends_with("(syntax errors near lines 2 — outline may be incomplete)")); }
#[test] fn blank_line_between_files() { assert!(out.contains("10-12\n\nb.rs (")); }
#[test] fn limit_header() { assert!(out.starts_with("showing 2 of 9 files (limit)\n")); }
#[test] fn output_cap_at_file_boundary() { /* 3 files × 900 symbols */ assert!(out.starts_with("showing 2 of 3 files (output limit) — narrow paths\n")); }
#[test] fn single_huge_file_truncated() { /* 1 file × 2500 symbols */ assert!(out.ends_with("(outline truncated — narrow with read_symbol)")); assert_eq!(out.lines().count(), 2001); }
#[test] fn numbered_matches_read() { assert_eq!(numbered("a\r\nb\r\nc", 2, 3), "     2\tb\n     3\tc"); }
#[test] fn sizes() { assert_eq!(human_size(3_565_158), "3.4 MB"); assert_eq!(human_size(2048), "2.0 KB"); }
```

- [ ] **Step 2: Run** `cargo test -p code-outline format`. Expected: FAIL.
- [ ] **Step 3: Implement** as specified.
- [ ] **Step 4: Run** `cargo test -p code-outline format`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(code-outline): outline and numbered-line formatting"`

---

### Task 8: Pipeline

**Files:**
- Create: `crates/code-outline/src/pipeline.rs` (tests inline, using tempdirs and the fixtures)

**Interfaces:**
- Consumes: `Context`, `repo_root`, `resolve_file`, `display`, `expand`, `Entry` (Task 6); `extract` (Task 2); `resolve`, `Resolution` (Task 5); `outline`, `numbered`, `human_size`, `FileOutline` (Task 7); `Lang`, `SUPPORTED` (Task 1)
- Produces:
  - `#[derive(Deserialize, JsonSchema)] #[serde(untagged)] pub enum Paths { One(String), Many(Vec<String>) }`
  - `#[derive(Deserialize, JsonSchema)] pub struct OutlineParams { pub paths: Paths, #[serde(default)] pub signatures: bool, #[serde(default = "default_limit")] pub limit: u32 }` — `default_limit() = 50`
  - `#[derive(Deserialize, JsonSchema)] pub struct ReadSymbolParams { pub path: String, pub symbol: String, pub line: Option<u32> }`
  - Short `///` docs on every field (they become schema descriptions).
  - `pub fn run_outline(p: &OutlineParams, ctx: &Context) -> Result<String, String>`
  - `pub fn run_read_symbol(p: &ReadSymbolParams, ctx: &Context) -> Result<String, String>`

**Rules:**
- Validation (`Err`): `limit` outside 1–500 → `"limit must be between 1 and 500"`; empty `paths` (empty string or empty list) → `"paths must not be empty"`; empty `path` → `"path must not be empty"`; empty `symbol` → `"symbol must not be empty"`; `line == 0` → `"line must be 1 or greater"`.
- `load(path) -> Result<(String, Vec<String> /*notes*/), String /*message*/>`: missing → `"<display> not found."`; size > 2 MB → size message; strip a leading UTF-8 BOM; `String::from_utf8` or lossy + the UTF-8 note.
- `run_outline`: `expand` → map entries to `FileOutline` (Missing → `"<p> not found."`, Unsupported → `"code-outline doesn't support .<ext> files — use Read."`, File → load + extract; error lines add the syntax-error note) → if there are no entries at all, return the empty-pattern / only-unsupported messages (one line per pattern) → `outline(...)` with `limit_hit = total > limit`.
- `run_read_symbol`: `resolve_file` → `Lang::from_path` (None → unsupported message) → load → extract → resolve. Found → `"{display}:{start}-{end} {kind} {qualified}\n" + numbered(...)`; Ambiguous → message + one line per hit `"{kind} {qualified} {start}-{end}"`; NotFound → the not-found message (with `Closest:` list joined by `, ` when non-empty).

- [ ] **Step 1: Write failing tests:**

```rust
#[test] fn validates_limit() { assert!(run_outline(&op("x", 0), &ctx).is_err()); assert!(run_outline(&op("x", 501), &ctx).is_err()); }
#[test] fn paths_string_or_list() { /* serde_json::from_value for "a.rs" and ["a.rs","b.rs"] both deserialize */ }
#[test] fn outline_two_files() { assert!(out.contains("a.rs (") && out.contains("\n\nb.py (")); }
#[test] fn missing_file_inline() { assert!(out.contains("nope.rs not found.")); }
#[test] fn unsupported_explicit() { assert_eq!(run_outline(&op("x.go", 50), &ctx).unwrap(), "code-outline doesn't support .go files — use Read."); }
#[test] fn empty_glob_message() { assert!(out.starts_with("0 files match build/*.rs in ") && out.ends_with(" (1 hidden by .gitignore)")); }
#[test] fn too_large() { /* 2 MB + 1 byte .rs */ assert!(out.contains("over the 2 MB limit — use Read with offset/limit.")); }
#[test] fn bom_file() { /* "\u{feff}class A {}\n" as a.cs */ assert!(out.contains("class A 1-1")); assert!(rs.contains("     1\tclass A {}")); }
#[test] fn invalid_utf8_note() { assert!(out.contains("(file is not valid UTF-8; some characters replaced)")); }
#[test] fn read_symbol_found() { assert_eq!(rs.lines().next().unwrap(), "a.rs:1-3 fn run"); assert!(rs.contains("     1\t/// Runs.")); }
#[test] fn read_symbol_ambiguous() { assert!(rs.starts_with("Add matches 2 symbols — pass line:\nmethod Demo.Calc.Add 5-7\n")); }
#[test] fn read_symbol_not_found() { assert_eq!(rs, "No symbol rnu in a.rs. Closest: run"); }
```

- [ ] **Step 2: Run** `cargo test -p code-outline pipeline`. Expected: FAIL.
- [ ] **Step 3: Implement** as specified.
- [ ] **Step 4: Run** `cargo test -p code-outline`. Expected: all PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(code-outline): outline and read_symbol pipeline"`

---

### Task 9: MCP server, packaging, release and live check

**Files:**
- Create: `crates/code-outline/src/server.rs`, `crates/code-outline/tests/protocol.rs`, `plugins/code-outline/.claude-plugin/plugin.json`, `plugins/code-outline/.mcp.json`, `plugins/code-outline/bin/code-outline.exe` (built)
- Modify: `crates/code-outline/src/main.rs`, `.claude-plugin/marketplace.json`, `scripts/release.ps1`, spec (record results)

**Interfaces:**
- Consumes: `OutlineParams`, `ReadSymbolParams`, `run_outline`, `run_read_symbol` (Task 8); `Context::from_env` (Task 6)
- Produces: `pub async fn server::run() -> anyhow::Result<()>`

- [ ] **Step 1: Write failing `tests/protocol.rs`**, modelled on `crates/everything-find/tests/protocol.rs`: spawn `CARGO_BIN_EXE_code-outline` with `CLAUDE_PROJECT_DIR` = `env!("CARGO_MANIFEST_DIR")`, initialize, then:
  - `tools/list`: names sorted == `["outline", "read_symbol"]`; descriptions equal the verbatim strings; `outline` required `["paths"]` with properties `limit, paths, signatures`; `read_symbol` required `["path", "symbol"]` with properties `line, path, symbol`; `serverInfo.name == "code-outline"`.
  - `tools/call outline {"paths": "tests/fixtures/sample.rs"}` → text starts with `tests/fixtures/sample.rs (`.
  - `tools/call read_symbol` on a symbol in `sample.rs` → text's second line starts with a 6-wide line number and a tab.
  - `tools/call outline {"paths": "x", "limit": 0}` → a JSON-RPC error mentioning `limit`.
- [ ] **Step 2: Run** `cargo test -p code-outline --test protocol`. Expected: FAIL.
- [ ] **Step 3: Implement `server.rs`** with the same shape as `crates/everything-find/src/server.rs`: struct `OutlineServer`, two `#[tool]` methods named `outline` and `read_symbol` with the verbatim descriptions, each running the pipeline in `spawn_blocking` with `Context::from_env()`; `Err(msg)` → `ErrorData::invalid_params(msg, None)`; server info `code-outline` / `CARGO_PKG_VERSION`. `main.rs` calls `code_outline::server::run()`.
- [ ] **Step 4: Run** `cargo test -p code-outline`. Expected: all PASS.
- [ ] **Step 5: Packaging.**
  - `plugins/code-outline/.claude-plugin/plugin.json`: `{ "name": "code-outline", "version": "0.1.0", "description": "Symbol outlines and single-symbol reads via tree-sitter (Rust, TS/JS, Python, C#)." }`
  - `plugins/code-outline/.mcp.json`: `{ "mcpServers": { "code-outline": { "command": "${CLAUDE_PLUGIN_ROOT}/bin/code-outline.exe" } } }`
  - Append to `.claude-plugin/marketplace.json` `plugins`: `{ "name": "code-outline", "source": "./plugins/code-outline", "description": "Symbol outlines and single-symbol reads via tree-sitter (Rust, TS/JS, Python, C#)." }`
  - `scripts/release.ps1`: loop over `everything-find`, `code-outline` doing the existing build + copy for each.
- [ ] **Step 6: Release build.** Run `pwsh scripts/release.ps1`. Expected: both exes copied. Record `code-outline.exe` size.
- [ ] **Step 7: Timing.** From the repo root, time an `outline {"paths": "crates/**/*.rs"}` call through the exe (reuse the protocol-test request sequence from a scratch script). Expected: < 100 ms for the call. Record the number.
- [ ] **Step 8: Live check in Claude Code.** Reinstall from the local marketplace, then ask: "show me FindServer::find in crates/everything-find". Expected: Claude calls `outline` and/or `read_symbol`, not Read, and can Edit using the returned line numbers. Compare the `outline` output size of `crates/everything-find/src/pipeline.rs` with the file's size (success criterion: ≥5× smaller).
- [ ] **Step 9: Record** exe size, timing and the token ratio in the spec under a new "Verified" note in Success criteria.
- [ ] **Step 10: Commit** `git add crates/code-outline plugins/code-outline .claude-plugin/marketplace.json scripts/release.ps1 docs/superpowers/specs/2026-10-20-code-outline-design.md Cargo.lock && git commit -m "feat(code-outline): MCP server and plugin packaging"`
