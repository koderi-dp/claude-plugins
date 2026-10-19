//! The `outline` and `read_symbol` tool pipelines.

use schemars::JsonSchema;
use serde::Deserialize;

use std::path::Path;

use crate::extract::extract;
use crate::files::{Context, Entry, display, expand, repo_root, resolve_file};
use crate::format::{FileOutline, human_size, numbered, outline};
use crate::lang::{Lang, SUPPORTED};
use crate::resolve::{Resolution, resolve};

#[derive(Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum Paths {
    One(String),
    Many(Vec<String>),
}

fn default_limit() -> u32 {
    50
}

#[derive(Deserialize, JsonSchema)]
pub struct OutlineParams {
    /// File path, glob, or list of them (relative to the repo root).
    pub paths: Paths,
    /// Show full signatures instead of names. Default false.
    #[serde(default)]
    pub signatures: bool,
    /// Maximum files to outline, 1-500. Default 50.
    #[serde(default = "default_limit")]
    pub limit: u32,
}

#[derive(Deserialize, JsonSchema)]
pub struct ReadSymbolParams {
    /// File path, relative to the repo root.
    pub path: String,
    /// Symbol name or qualified path, e.g. ApiClient.get or FindServer::find.
    pub symbol: String,
    /// 1-based line inside the symbol, to pick between overloads.
    pub line: Option<u32>,
}

const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
const BOM: &[u8] = b"\xEF\xBB\xBF";
const LOSSY_NOTE: &str = "(file is not valid UTF-8; some characters replaced)";

fn unsupported_message(path: &Path) -> String {
    match path.extension().filter(|e| !e.is_empty()) {
        Some(ext) => format!(
            "code-outline doesn't support .{} files — use Read.",
            ext.to_string_lossy()
        ),
        None => format!(
            "code-outline doesn't support {} — use Read.",
            path.file_name()
                .unwrap_or(path.as_os_str())
                .to_string_lossy()
        ),
    }
}

fn no_match_message(pattern: &str, hidden: usize, root: &Path) -> String {
    let mut line = format!("0 files match {pattern} in {}", root.display());
    if hidden > 0 {
        line.push_str(&format!(" ({hidden} hidden by .gitignore)"));
    }
    line
}

fn error_note(lines: &[usize]) -> String {
    let list = lines
        .iter()
        .map(usize::to_string)
        .collect::<Vec<_>>()
        .join(", ");
    format!("(syntax errors near lines {list} — outline may be incomplete)")
}

/// Reads a file as text: BOM stripped, invalid UTF-8 replaced (with a note).
/// `Err` carries a user-facing message, not a failure.
fn load(root: &Path, path: &Path) -> Result<(String, Vec<String>), String> {
    let shown = display(root, path);
    let meta = match std::fs::metadata(path) {
        Ok(m) if m.is_file() => m,
        _ => return Err(format!("{shown} not found.")),
    };
    if meta.len() > MAX_FILE_BYTES {
        return Err(format!(
            "{shown} is {}, over the 2 MB limit — use Read with offset/limit.",
            human_size(meta.len())
        ));
    }
    let bytes = std::fs::read(path).map_err(|e| format!("{shown} could not be read: {e}."))?;
    let bytes = bytes.strip_prefix(BOM).unwrap_or(&bytes);
    Ok(match std::str::from_utf8(bytes) {
        Ok(s) => (s.to_string(), Vec::new()),
        Err(_) => (
            String::from_utf8_lossy(bytes).into_owned(),
            vec![LOSSY_NOTE.to_string()],
        ),
    })
}

fn file_outline(root: &Path, path: &Path, lang: Lang) -> FileOutline {
    let (source, mut notes) = match load(root, path) {
        Ok(loaded) => loaded,
        Err(message) => return FileOutline::Message(message),
    };
    let extracted = extract(&source, lang);
    if !extracted.error_lines.is_empty() {
        notes.push(error_note(&extracted.error_lines));
    }
    FileOutline::Symbols {
        display: display(root, path),
        line_count: source.lines().count(),
        symbols: extracted.symbols,
        notes,
    }
}

pub fn run_outline(p: &OutlineParams, ctx: &Context) -> Result<String, String> {
    if !(1..=500).contains(&p.limit) {
        return Err("limit must be between 1 and 500".into());
    }
    let patterns: Vec<String> = match &p.paths {
        Paths::One(s) => vec![s.clone()],
        Paths::Many(v) => v.clone(),
    };
    if patterns.is_empty() || patterns.iter().any(|s| s.trim().is_empty()) {
        return Err("paths must not be empty".into());
    }

    let root = repo_root(ctx);
    let expanded = expand(&root, &patterns, p.limit as usize);
    if expanded.entries.is_empty() {
        let mut lines: Vec<String> = expanded
            .empty_patterns
            .iter()
            .map(|(pattern, hidden)| no_match_message(pattern, *hidden, &root))
            .collect();
        if expanded.unsupported_only > 0 {
            lines.push(format!(
                "{} files matched but none are supported ({SUPPORTED}) — use Read.",
                expanded.unsupported_only
            ));
        }
        return Ok(lines.join("\n"));
    }

    let files: Vec<FileOutline> = expanded
        .entries
        .iter()
        .map(|entry| match entry {
            Entry::Missing(pattern) => FileOutline::Message(format!("{pattern} not found.")),
            Entry::Unsupported(pattern) => {
                FileOutline::Message(unsupported_message(Path::new(pattern)))
            }
            Entry::NoMatch(pattern, hidden) => {
                FileOutline::Message(no_match_message(pattern, *hidden, &root))
            }
            Entry::File(path, lang) => file_outline(&root, path, *lang),
        })
        .collect();
    Ok(outline(
        &files,
        expanded.total,
        expanded.total > p.limit as usize,
        p.signatures,
    ))
}

pub fn run_read_symbol(p: &ReadSymbolParams, ctx: &Context) -> Result<String, String> {
    if p.path.is_empty() {
        return Err("path must not be empty".into());
    }
    if p.symbol.trim().is_empty() {
        return Err("symbol must not be empty".into());
    }
    if p.line == Some(0) {
        return Err("line must be 1 or greater".into());
    }

    let root = repo_root(ctx);
    let path = resolve_file(&root, &p.path);
    let shown = display(&root, &path);
    if path.is_dir() {
        return Ok(format!("{shown} is a directory — pass a file."));
    }
    let Some(lang) = Lang::from_path(&path) else {
        return Ok(unsupported_message(&path));
    };
    let (source, notes) = match load(&root, &path) {
        Ok(loaded) => loaded,
        Err(message) => return Ok(message),
    };
    let extracted = extract(&source, lang);
    let out = match resolve(
        &extracted.symbols,
        lang,
        &p.symbol,
        p.line.map(|n| n as usize),
    ) {
        Resolution::Found(hit) => {
            let s = hit.symbol;
            format!(
                "{shown}:{}-{} {} {}\n{}",
                s.start_line,
                s.end_line,
                s.kind,
                hit.qualified,
                numbered(&source, s.start_line, s.end_line)
            )
        }
        Resolution::Ambiguous(hits) => {
            let mut out = format!("{} matches {} symbols — pass line:", p.symbol, hits.len());
            for hit in &hits {
                out.push_str(&format!(
                    "\n{} {} {}-{}",
                    hit.symbol.kind, hit.qualified, hit.symbol.start_line, hit.symbol.end_line
                ));
            }
            out
        }
        Resolution::NotFound(closest) => {
            let mut out = format!("No symbol {} in {shown}.", p.symbol);
            if !closest.is_empty() {
                out.push_str(&format!(" Closest: {}", closest.join(", ")));
            }
            out
        }
    };
    Ok(notes.iter().fold(out, |acc, note| format!("{acc}\n{note}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup(files: &[(&str, &[u8])]) -> (tempfile::TempDir, Context) {
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        for (p, body) in files {
            let f = root.join(p);
            std::fs::create_dir_all(f.parent().unwrap()).unwrap();
            std::fs::write(f, body).unwrap();
        }
        let ctx = Context {
            cwd: root,
            project_dir: None,
        };
        (dir, ctx)
    }

    fn op(path: &str, limit: u32) -> OutlineParams {
        OutlineParams {
            paths: Paths::One(path.into()),
            signatures: false,
            limit,
        }
    }

    fn rsp(path: &str, symbol: &str, line: Option<u32>) -> ReadSymbolParams {
        ReadSymbolParams {
            path: path.into(),
            symbol: symbol.into(),
            line,
        }
    }

    const DEMO: &str = "namespace Demo\n{\n    class Calc\n    {\n        int Add(int a)\n        {\n            return a;\n        }\n\n        int Add(int a, int b)\n        {\n            return a + b;\n        }\n    }\n}\n";

    #[test]
    fn validates_limit() {
        let (_d, ctx) = setup(&[]);
        assert_eq!(
            run_outline(&op("x", 0), &ctx).unwrap_err(),
            "limit must be between 1 and 500"
        );
        assert!(run_outline(&op("x", 501), &ctx).is_err());
    }

    #[test]
    fn validates_empty_inputs() {
        let (_d, ctx) = setup(&[]);
        assert_eq!(
            run_outline(&op("", 50), &ctx).unwrap_err(),
            "paths must not be empty"
        );
        let empty = OutlineParams {
            paths: Paths::Many(vec![]),
            signatures: false,
            limit: 50,
        };
        assert_eq!(
            run_outline(&empty, &ctx).unwrap_err(),
            "paths must not be empty"
        );
        assert_eq!(
            run_read_symbol(&rsp("", "a", None), &ctx).unwrap_err(),
            "path must not be empty"
        );
        assert_eq!(
            run_read_symbol(&rsp("a.rs", "", None), &ctx).unwrap_err(),
            "symbol must not be empty"
        );
        assert_eq!(
            run_read_symbol(&rsp("a.rs", "a", Some(0)), &ctx).unwrap_err(),
            "line must be 1 or greater"
        );
    }

    #[test]
    fn blank_entry_in_list_is_rejected() {
        let (_d, ctx) = setup(&[]);
        for bad in ["", "  "] {
            let p = OutlineParams {
                paths: Paths::Many(vec!["a.rs".into(), bad.into()]),
                signatures: false,
                limit: 50,
            };
            assert_eq!(
                run_outline(&p, &ctx).unwrap_err(),
                "paths must not be empty"
            );
        }
        assert_eq!(
            run_outline(&op("  ", 50), &ctx).unwrap_err(),
            "paths must not be empty"
        );
    }

    #[test]
    fn read_symbol_keeps_utf8_note() {
        let note = "(file is not valid UTF-8; some characters replaced)";
        let (_d, ctx) = setup(&[("a.rs", b"fn run() {} // \xff\nfn run2() {}\n")]);
        let found = run_read_symbol(&rsp("a.rs", "run", None), &ctx).unwrap();
        assert!(found.ends_with(&format!("\n{note}")), "{found}");
        let missing = run_read_symbol(&rsp("a.rs", "zzzzzzzzzz", None), &ctx).unwrap();
        assert_eq!(missing, format!("No symbol zzzzzzzzzz in a.rs.\n{note}"));
    }

    #[test]
    fn paths_string_or_list() {
        let one: OutlineParams =
            serde_json::from_value(serde_json::json!({"paths": "a.rs"})).unwrap();
        assert!(matches!(one.paths, Paths::One(ref s) if s == "a.rs"));
        assert!(!one.signatures && one.limit == 50);
        let many: OutlineParams =
            serde_json::from_value(serde_json::json!({"paths": ["a.rs", "b.rs"]})).unwrap();
        assert!(matches!(many.paths, Paths::Many(ref v) if v.len() == 2));
    }

    #[test]
    fn outline_two_files() {
        let (_d, ctx) = setup(&[
            ("a.rs", b"fn run() {}\n"),
            ("b.py", b"def go():\n    pass\n"),
        ]);
        let p = OutlineParams {
            paths: Paths::Many(vec!["a.rs".into(), "b.py".into()]),
            signatures: false,
            limit: 50,
        };
        let out = run_outline(&p, &ctx).unwrap();
        assert!(
            out.contains("a.rs (") && out.contains("\n\nb.py ("),
            "{out}"
        );
    }

    #[test]
    fn missing_file_inline() {
        let (_d, ctx) = setup(&[("a.rs", b"fn run() {}\n")]);
        let p = OutlineParams {
            paths: Paths::Many(vec!["nope.rs".into(), "a.rs".into()]),
            signatures: false,
            limit: 50,
        };
        let out = run_outline(&p, &ctx).unwrap();
        assert!(
            out.contains("nope.rs not found.") && out.contains("fn run 1-1"),
            "{out}"
        );
    }

    #[test]
    fn unsupported_explicit() {
        let (_d, ctx) = setup(&[("x.go", b"package x\n")]);
        assert_eq!(
            run_outline(&op("x.go", 50), &ctx).unwrap(),
            "code-outline doesn't support .go files — use Read."
        );
    }

    #[test]
    fn empty_glob_message() {
        let (_d, ctx) = setup(&[(".gitignore", b"build/\n"), ("build/gen.rs", b"")]);
        let out = run_outline(&op("build/*.rs", 50), &ctx).unwrap();
        assert!(
            out.starts_with("0 files match build/*.rs in ")
                && out.ends_with(" (1 hidden by .gitignore)"),
            "{out}"
        );
    }

    #[test]
    fn only_unsupported_glob_message() {
        let (_d, ctx) = setup(&[("a.go", b""), ("b.go", b"")]);
        assert_eq!(
            run_outline(&op("*.go", 50), &ctx).unwrap(),
            "2 files matched but none are supported (rs, ts, tsx, js, jsx, mjs, cjs, py, cs) — use Read."
        );
    }

    #[test]
    fn limit_header() {
        let (_d, ctx) = setup(&[("a.rs", b"fn a() {}\n"), ("b.rs", b"fn b() {}\n")]);
        let out = run_outline(&op("*.rs", 1), &ctx).unwrap();
        assert!(out.starts_with("showing 1 of 2 files (limit)\n"), "{out}");
    }

    #[test]
    fn too_large() {
        let big = vec![b'a'; 2 * 1024 * 1024 + 1];
        let (_d, ctx) = setup(&[("big.rs", &big)]);
        let out = run_outline(&op("big.rs", 50), &ctx).unwrap();
        assert!(
            out.contains("big.rs is 2.0 MB, over the 2 MB limit — use Read with offset/limit."),
            "{out}"
        );
        let rs = run_read_symbol(&rsp("big.rs", "x", None), &ctx).unwrap();
        assert!(rs.contains("over the 2 MB limit"), "{rs}");
    }

    #[test]
    fn bom_file() {
        let (_d, ctx) = setup(&[("a.cs", "\u{feff}class A {}\n".as_bytes())]);
        let out = run_outline(&op("a.cs", 50), &ctx).unwrap();
        assert!(out.contains("class A 1-1"), "{out}");
        let rs = run_read_symbol(&rsp("a.cs", "A", None), &ctx).unwrap();
        assert!(rs.contains("     1\tclass A {}"), "{rs}");
    }

    #[test]
    fn invalid_utf8_note() {
        let (_d, ctx) = setup(&[("a.rs", b"fn run() {} // \xff\n")]);
        let out = run_outline(&op("a.rs", 50), &ctx).unwrap();
        assert!(
            out.contains("(file is not valid UTF-8; some characters replaced)"),
            "{out}"
        );
    }

    #[test]
    fn syntax_error_note() {
        let (_d, ctx) = setup(&[("a.rs", b"fn ok() {}\nfn broken( {\n")]);
        let out = run_outline(&op("a.rs", 50), &ctx).unwrap();
        assert!(
            out.contains("(syntax errors near lines ")
                && out.contains("— outline may be incomplete)"),
            "{out}"
        );
    }

    #[test]
    fn read_symbol_found() {
        let (_d, ctx) = setup(&[("a.rs", b"/// Runs.\nfn run() {\n}\n")]);
        let rs = run_read_symbol(&rsp("a.rs", "run", None), &ctx).unwrap();
        assert_eq!(rs.lines().next().unwrap(), "a.rs:1-3 fn run");
        assert!(rs.contains("     1\t/// Runs."), "{rs}");
    }

    #[test]
    fn read_symbol_ambiguous() {
        let (_d, ctx) = setup(&[("Calc.cs", DEMO.as_bytes())]);
        let rs = run_read_symbol(&rsp("Calc.cs", "Add", None), &ctx).unwrap();
        assert!(
            rs.starts_with("Add matches 2 symbols — pass line:\nmethod Demo.Calc.Add 5-8\n"),
            "{rs}"
        );
        let off = run_read_symbol(&rsp("Calc.cs", "Add", Some(1)), &ctx).unwrap();
        assert!(off.starts_with("Add matches 2 symbols"), "{off}");
        let ok = run_read_symbol(&rsp("Calc.cs", "Add", Some(11)), &ctx).unwrap();
        assert!(
            ok.starts_with("Calc.cs:10-13 method Demo.Calc.Add\n"),
            "{ok}"
        );
    }

    #[test]
    fn read_symbol_not_found() {
        let (_d, ctx) = setup(&[("a.rs", b"fn run() {}\n")]);
        let rs = run_read_symbol(&rsp("a.rs", "rnu", None), &ctx).unwrap();
        assert_eq!(rs, "No symbol rnu in a.rs. Closest: run");
        let none = run_read_symbol(&rsp("a.rs", "zzzzzzzzzz", None), &ctx).unwrap();
        assert_eq!(none, "No symbol zzzzzzzzzz in a.rs.");
    }

    fn many(paths: &[&str]) -> OutlineParams {
        OutlineParams {
            paths: Paths::Many(paths.iter().map(|s| s.to_string()).collect()),
            signatures: false,
            limit: 50,
        }
    }

    #[test]
    fn outline_bracket_path() {
        let (_d, ctx) = setup(&[("app/[id]/page.tsx", b"export function Page() {}\n")]);
        let out = run_outline(&op("app/[id]/page.tsx", 50), &ctx).unwrap();
        assert!(
            out.starts_with("app/[id]/page.tsx (1 lines)\n  function Page 1-1"),
            "{out}"
        );
    }

    #[test]
    fn outline_directory() {
        let (_d, ctx) = setup(&[
            ("src/a.rs", b"fn a() {}\n"),
            ("src/sub/b.py", b"def b():\n    pass\n"),
        ]);
        let out = run_outline(&op("src", 50), &ctx).unwrap();
        assert!(
            out.contains("src/a.rs (1 lines)") && out.contains("src/sub/b.py (2 lines)"),
            "{out}"
        );
    }

    #[test]
    fn read_symbol_on_directory() {
        let (_d, ctx) = setup(&[("src/a.rs", b"fn a() {}\n"), ("dir.rs/x.rs", b"")]);
        assert_eq!(
            run_read_symbol(&rsp("src", "a", None), &ctx).unwrap(),
            "src is a directory — pass a file."
        );
        assert_eq!(
            run_read_symbol(&rsp("dir.rs", "a", None), &ctx).unwrap(),
            "dir.rs is a directory — pass a file."
        );
    }

    #[test]
    fn mixed_patterns_report_empty_ones() {
        let (d, ctx) = setup(&[
            (".gitignore", b"build/\n"),
            ("a.rs", b"fn a() {}\n"),
            ("build/gen.rs", b""),
        ]);
        let root = dunce::canonicalize(d.path()).unwrap();
        let out = run_outline(&many(&["a.rs", "nothing/*.rs", "build/*.rs"]), &ctx).unwrap();
        let root = root.display();
        assert!(
            out.contains(&format!("0 files match nothing/*.rs in {root}")),
            "{out}"
        );
        assert!(
            out.contains(&format!(
                "0 files match build/*.rs in {root} (1 hidden by .gitignore)"
            )),
            "{out}"
        );
        assert!(out.contains("a.rs (1 lines)\n  fn a 1-1"), "{out}");
        let missing = run_outline(&many(&["nope.rs", "nothing/*.rs"]), &ctx).unwrap();
        assert!(
            missing.contains("nope.rs not found.")
                && missing.contains("0 files match nothing/*.rs"),
            "{missing}"
        );
    }

    #[test]
    fn file_without_extension() {
        let (_d, ctx) = setup(&[("Makefile", b"all:\n")]);
        let msg = "code-outline doesn't support Makefile — use Read.";
        assert_eq!(run_outline(&op("Makefile", 50), &ctx).unwrap(), msg);
        assert_eq!(
            run_read_symbol(&rsp("Makefile", "all", None), &ctx).unwrap(),
            msg
        );
    }

    #[test]
    fn blank_symbol_is_rejected() {
        let (_d, ctx) = setup(&[("a.rs", b"fn a() {}\n")]);
        assert_eq!(
            run_read_symbol(&rsp("a.rs", "  ", None), &ctx).unwrap_err(),
            "symbol must not be empty"
        );
    }

    /// Runs `f` on a thread with the 1 MB stack the Windows exe's main thread has.
    fn on_small_stack<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> T {
        std::thread::Builder::new()
            .stack_size(1 << 20)
            .spawn(f)
            .unwrap()
            .join()
            .unwrap()
    }

    #[test]
    fn deeply_nested_functions_do_not_overflow() {
        let src = format!(
            "{}{}",
            "function a(){\n".repeat(10_000),
            "}\n".repeat(10_000)
        );
        let (dir, ctx) = setup(&[("deep.js", src.as_bytes())]);
        let (out, rs) = on_small_stack(move || {
            let out = run_outline(&op("deep.js", 50), &ctx).unwrap();
            let rs = run_read_symbol(&rsp("deep.js", "a", Some(10_000)), &ctx).unwrap();
            (out, rs)
        });
        drop(dir);
        assert!(out.lines().count() <= 2001, "{} lines", out.lines().count());
        assert!(
            out.ends_with("(outline truncated — narrow with read_symbol)"),
            "{out}"
        );
        assert!(
            out.lines().all(|l| l.len() < 200),
            "indentation must be capped"
        );
        assert!(rs.starts_with("deep.js:"), "{}", &rs[..rs.len().min(300)]);
    }

    #[test]
    fn read_symbol_missing_and_unsupported() {
        let (_d, ctx) = setup(&[("x.go", b"package x\n")]);
        assert_eq!(
            run_read_symbol(&rsp("nope.rs", "a", None), &ctx).unwrap(),
            "nope.rs not found."
        );
        assert_eq!(
            run_read_symbol(&rsp("x.go", "a", None), &ctx).unwrap(),
            "code-outline doesn't support .go files — use Read."
        );
    }
}
