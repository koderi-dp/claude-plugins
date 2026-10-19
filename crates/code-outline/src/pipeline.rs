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

fn unsupported_message(ext: &str) -> String {
    format!("code-outline doesn't support .{ext} files — use Read.")
}

fn error_note(lines: &[usize]) -> String {
    let list = lines.iter().map(usize::to_string).collect::<Vec<_>>().join(", ");
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
        Err(_) => (String::from_utf8_lossy(bytes).into_owned(), vec![LOSSY_NOTE.to_string()]),
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
            .map(|(pattern, hidden)| {
                let mut line = format!("0 files match {pattern} in {}", root.display());
                if *hidden > 0 {
                    line.push_str(&format!(" ({hidden} hidden by .gitignore)"));
                }
                line
            })
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
            Entry::Unsupported(_, ext) => FileOutline::Message(unsupported_message(ext)),
            Entry::File(path, lang) => file_outline(&root, path, *lang),
        })
        .collect();
    Ok(outline(&files, expanded.total, expanded.total > p.limit as usize, p.signatures))
}

pub fn run_read_symbol(p: &ReadSymbolParams, ctx: &Context) -> Result<String, String> {
    if p.path.is_empty() {
        return Err("path must not be empty".into());
    }
    if p.symbol.is_empty() {
        return Err("symbol must not be empty".into());
    }
    if p.line == Some(0) {
        return Err("line must be 1 or greater".into());
    }

    let root = repo_root(ctx);
    let path = resolve_file(&root, &p.path);
    let shown = display(&root, &path);
    let Some(lang) = Lang::from_path(&path) else {
        let ext = path.extension().map(|e| e.to_string_lossy().into_owned()).unwrap_or_default();
        return Ok(unsupported_message(&ext));
    };
    let (source, notes) = match load(&root, &path) {
        Ok(loaded) => loaded,
        Err(message) => return Ok(message),
    };
    let extracted = extract(&source, lang);
    let out = match resolve(&extracted.symbols, lang, &p.symbol, p.line.map(|n| n as usize)) {
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
        let ctx = Context { cwd: root, project_dir: None };
        (dir, ctx)
    }

    fn op(path: &str, limit: u32) -> OutlineParams {
        OutlineParams { paths: Paths::One(path.into()), signatures: false, limit }
    }

    fn rsp(path: &str, symbol: &str, line: Option<u32>) -> ReadSymbolParams {
        ReadSymbolParams { path: path.into(), symbol: symbol.into(), line }
    }

    const DEMO: &str = "namespace Demo\n{\n    class Calc\n    {\n        int Add(int a)\n        {\n            return a;\n        }\n\n        int Add(int a, int b)\n        {\n            return a + b;\n        }\n    }\n}\n";

    #[test]
    fn validates_limit() {
        let (_d, ctx) = setup(&[]);
        assert_eq!(run_outline(&op("x", 0), &ctx).unwrap_err(), "limit must be between 1 and 500");
        assert!(run_outline(&op("x", 501), &ctx).is_err());
    }

    #[test]
    fn validates_empty_inputs() {
        let (_d, ctx) = setup(&[]);
        assert_eq!(run_outline(&op("", 50), &ctx).unwrap_err(), "paths must not be empty");
        let empty = OutlineParams { paths: Paths::Many(vec![]), signatures: false, limit: 50 };
        assert_eq!(run_outline(&empty, &ctx).unwrap_err(), "paths must not be empty");
        assert_eq!(run_read_symbol(&rsp("", "a", None), &ctx).unwrap_err(), "path must not be empty");
        assert_eq!(run_read_symbol(&rsp("a.rs", "", None), &ctx).unwrap_err(), "symbol must not be empty");
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
            assert_eq!(run_outline(&p, &ctx).unwrap_err(), "paths must not be empty");
        }
        assert_eq!(run_outline(&op("  ", 50), &ctx).unwrap_err(), "paths must not be empty");
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
        let one: OutlineParams = serde_json::from_value(serde_json::json!({"paths": "a.rs"})).unwrap();
        assert!(matches!(one.paths, Paths::One(ref s) if s == "a.rs"));
        assert!(!one.signatures && one.limit == 50);
        let many: OutlineParams =
            serde_json::from_value(serde_json::json!({"paths": ["a.rs", "b.rs"]})).unwrap();
        assert!(matches!(many.paths, Paths::Many(ref v) if v.len() == 2));
    }

    #[test]
    fn outline_two_files() {
        let (_d, ctx) = setup(&[("a.rs", b"fn run() {}\n"), ("b.py", b"def go():\n    pass\n")]);
        let p = OutlineParams {
            paths: Paths::Many(vec!["a.rs".into(), "b.py".into()]),
            signatures: false,
            limit: 50,
        };
        let out = run_outline(&p, &ctx).unwrap();
        assert!(out.contains("a.rs (") && out.contains("\n\nb.py ("), "{out}");
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
        assert!(out.contains("nope.rs not found.") && out.contains("fn run 1-1"), "{out}");
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
            out.starts_with("0 files match build/*.rs in ") && out.ends_with(" (1 hidden by .gitignore)"),
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
        assert!(out.contains("big.rs is 2.0 MB, over the 2 MB limit — use Read with offset/limit."), "{out}");
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
        assert!(out.contains("(file is not valid UTF-8; some characters replaced)"), "{out}");
    }

    #[test]
    fn syntax_error_note() {
        let (_d, ctx) = setup(&[("a.rs", b"fn ok() {}\nfn broken( {\n")]);
        let out = run_outline(&op("a.rs", 50), &ctx).unwrap();
        assert!(
            out.contains("(syntax errors near lines ") && out.contains("— outline may be incomplete)"),
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
        assert!(rs.starts_with("Add matches 2 symbols — pass line:\nmethod Demo.Calc.Add 5-8\n"), "{rs}");
        let off = run_read_symbol(&rsp("Calc.cs", "Add", Some(1)), &ctx).unwrap();
        assert!(off.starts_with("Add matches 2 symbols"), "{off}");
        let ok = run_read_symbol(&rsp("Calc.cs", "Add", Some(11)), &ctx).unwrap();
        assert!(ok.starts_with("Calc.cs:10-13 method Demo.Calc.Add\n"), "{ok}");
    }

    #[test]
    fn read_symbol_not_found() {
        let (_d, ctx) = setup(&[("a.rs", b"fn run() {}\n")]);
        let rs = run_read_symbol(&rsp("a.rs", "rnu", None), &ctx).unwrap();
        assert_eq!(rs, "No symbol rnu in a.rs. Closest: run");
        let none = run_read_symbol(&rsp("a.rs", "zzzzzzzzzz", None), &ctx).unwrap();
        assert_eq!(none, "No symbol zzzzzzzzzz in a.rs.");
    }

    /// Runs `f` on a thread with the 1 MB stack the Windows exe's main thread has.
    fn on_small_stack<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> T {
        std::thread::Builder::new().stack_size(1 << 20).spawn(f).unwrap().join().unwrap()
    }

    #[test]
    fn deeply_nested_functions_do_not_overflow() {
        let src = format!("{}{}", "function a(){\n".repeat(10_000), "}\n".repeat(10_000));
        let (dir, ctx) = setup(&[("deep.js", src.as_bytes())]);
        let (out, rs) = on_small_stack(move || {
            let out = run_outline(&op("deep.js", 50), &ctx).unwrap();
            let rs = run_read_symbol(&rsp("deep.js", "a", Some(10_000)), &ctx).unwrap();
            (out, rs)
        });
        drop(dir);
        assert!(out.lines().count() <= 2001, "{} lines", out.lines().count());
        assert!(out.ends_with("(outline truncated — narrow with read_symbol)"), "{out}");
        assert!(out.lines().all(|l| l.len() < 200), "indentation must be capped");
        assert!(rs.starts_with("deep.js:"), "{}", &rs[..rs.len().min(300)]);
    }

    #[test]
    fn read_symbol_missing_and_unsupported() {
        let (_d, ctx) = setup(&[("x.go", b"package x\n")]);
        assert_eq!(run_read_symbol(&rsp("nope.rs", "a", None), &ctx).unwrap(), "nope.rs not found.");
        assert_eq!(
            run_read_symbol(&rsp("x.go", "a", None), &ctx).unwrap(),
            "code-outline doesn't support .go files — use Read."
        );
    }
}
