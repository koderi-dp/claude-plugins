//! Repo root discovery and path/glob expansion into outline targets.

use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};

use crate::lang::Lang;

#[derive(Clone)]
pub struct Context {
    pub cwd: PathBuf,
    pub project_dir: Option<PathBuf>,
}

impl Context {
    pub fn from_env() -> Context {
        Context {
            cwd: std::env::current_dir().unwrap_or_default(),
            project_dir: std::env::var_os("CLAUDE_PROJECT_DIR").map(PathBuf::from),
        }
    }
}

pub enum Entry {
    File(PathBuf, Lang),
    Missing(String),
    Unsupported(String, String),
}

pub struct Expanded {
    pub entries: Vec<Entry>,
    pub total: usize,
    pub empty_patterns: Vec<(String, usize)>,
    pub unsupported_only: usize,
}

/// Canonical so 8.3 short names and `..` compare equal to real paths.
pub fn repo_root(ctx: &Context) -> PathBuf {
    let dir = match &ctx.project_dir {
        Some(dir) if dir.is_dir() => dir.clone(),
        _ => ctx.cwd.clone(),
    };
    dunce::canonicalize(&dir).unwrap_or(dir)
}

pub fn resolve_file(root: &Path, path: &str) -> PathBuf {
    let p = Path::new(path);
    let joined = if p.is_absolute() { p.to_path_buf() } else { root.join(p) };
    dunce::canonicalize(&joined).unwrap_or(joined)
}

/// Strips `root` from `path`, comparing components case-insensitively.
fn strip_root_ci(path: &Path, root: &Path) -> Option<PathBuf> {
    let mut path_parts = path.components().filter(|c| !matches!(c, Component::CurDir));
    for root_part in root.components().filter(|c| !matches!(c, Component::CurDir)) {
        let p = path_parts.next()?;
        let (a, b) = (p.as_os_str().to_string_lossy(), root_part.as_os_str().to_string_lossy());
        if a != b && a.to_lowercase() != b.to_lowercase() {
            return None;
        }
    }
    Some(path_parts.collect())
}

/// Root-relative with `/` separators when under `root`, else the absolute path.
pub fn display(root: &Path, path: &Path) -> String {
    match strip_root_ci(path, root) {
        Some(rel) => rel
            .components()
            .map(|c| c.as_os_str().to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join("/"),
        None => path.to_string_lossy().into_owned(),
    }
}

fn is_glob(pattern: &str) -> bool {
    pattern.contains(['*', '?', '[', '{'])
}

fn ext_of(path: &Path) -> String {
    path.extension().map(|e| e.to_string_lossy().into_owned()).unwrap_or_default()
}

/// Walks `base`, returning the supported files (with language) whose
/// base-relative path matches `matcher`, plus the number of unsupported matches.
/// When `base` is inside `root` the walk starts at `root` (pruned to the path
/// towards `base`), so ignore rules apply to `base` itself, e.g. `build/`.
fn walk_matches(
    root: &Path,
    base: &Path,
    matcher: &globset::GlobMatcher,
    standard_filters: bool,
) -> (Vec<(PathBuf, Lang)>, usize) {
    let start = if base.starts_with(root) { root } else { base };
    let target = base.to_path_buf();
    let mut builder = ignore::WalkBuilder::new(start);
    builder
        .hidden(false)
        .require_git(false)
        .parents(true)
        .filter_entry(move |e| {
            e.file_name() != ".git" && (e.path().starts_with(&target) || target.starts_with(e.path()))
        });
    if !standard_filters {
        builder.standard_filters(false);
    }
    let mut supported = Vec::new();
    let mut unsupported = 0;
    for entry in builder.build().flatten() {
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        let Ok(rel) = entry.path().strip_prefix(base) else { continue };
        let rel = rel.to_string_lossy().replace('\\', "/");
        if !matcher.is_match(&rel) {
            continue;
        }
        match Lang::from_path(entry.path()) {
            Some(lang) => supported.push((entry.path().to_path_buf(), lang)),
            None => unsupported += 1,
        }
    }
    (supported, unsupported)
}

pub fn expand(root: &Path, patterns: &[String], limit: usize) -> Expanded {
    let mut diagnostics = Vec::new();
    let mut files: Vec<(String, PathBuf, Lang)> = Vec::new();
    let mut seen = HashSet::new();
    let mut empty_patterns = Vec::new();
    let mut unsupported_only = 0;

    let mut add_file = |files: &mut Vec<(String, PathBuf, Lang)>, path: PathBuf, lang: Lang| {
        let key = dunce::canonicalize(&path).unwrap_or_else(|_| path.clone());
        if seen.insert(key.clone()) {
            files.push((display(root, &key), key, lang));
        }
    };

    for original in patterns {
        let pattern = original.replace('\\', "/");
        if !is_glob(&pattern) {
            let path = resolve_file(root, &pattern);
            if !path.is_file() {
                diagnostics.push(Entry::Missing(pattern));
            } else if let Some(lang) = Lang::from_path(&path) {
                add_file(&mut files, path, lang);
            } else {
                diagnostics.push(Entry::Unsupported(pattern, ext_of(&path)));
            }
            continue;
        }

        let parts: Vec<&str> = pattern.split('/').collect();
        let literal_len = parts.iter().take_while(|p| !is_glob(p)).count();
        let base_str = match parts[..literal_len].join("/") {
            s if s.is_empty() && pattern.starts_with('/') => "/".to_string(),
            s => s,
        };
        let base = resolve_file(root, &base_str);
        let rest = parts[literal_len..].join("/");
        let matcher = match globset::GlobBuilder::new(&rest).literal_separator(true).build() {
            Ok(glob) => glob.compile_matcher(),
            Err(_) => {
                empty_patterns.push((pattern, 0));
                continue;
            }
        };

        let (supported, unsupported) = walk_matches(root, &base, &matcher, true);
        if supported.is_empty() {
            if unsupported > 0 {
                unsupported_only += unsupported;
            } else {
                let (hidden, _) = walk_matches(root, &base, &matcher, false);
                empty_patterns.push((pattern, hidden.len()));
            }
            continue;
        }
        for (path, lang) in supported {
            add_file(&mut files, path, lang);
        }
    }

    files.sort_by(|a, b| a.0.cmp(&b.0));
    let mut entries = diagnostics;
    entries.extend(files.into_iter().map(|(_, path, lang)| Entry::File(path, lang)));
    let total = entries.len();
    entries.truncate(limit);
    Expanded { entries, total, empty_patterns, unsupported_only }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        for (p, body) in [
            (".gitignore", "build/\n"),
            ("src/a.rs", ""),
            ("src/b.ts", ""),
            ("src/c.go", ""),
            ("src/deep/d.py", ""),
            ("build/gen.rs", ""),
            ("My Dir/e.cs", ""),
        ] {
            let f = root.join(p);
            std::fs::create_dir_all(f.parent().unwrap()).unwrap();
            std::fs::write(f, body).unwrap();
        }
        (dir, root)
    }

    fn names(root: &Path, x: &Expanded) -> Vec<String> {
        x.entries
            .iter()
            .filter_map(|e| match e {
                Entry::File(p, _) => Some(display(root, p)),
                _ => None,
            })
            .collect()
    }

    fn ex(root: &Path, pattern: &str) -> Expanded {
        expand(root, &[pattern.to_string()], 50)
    }

    #[test]
    fn glob_respects_gitignore() {
        let (_d, root) = repo();
        assert_eq!(names(&root, &ex(&root, "**/*.rs")), ["src/a.rs"]);
    }

    #[test]
    fn double_star_and_braces() {
        let (_d, root) = repo();
        assert_eq!(names(&root, &ex(&root, "src/**/*.{ts,py}")), ["src/b.ts", "src/deep/d.py"]);
    }

    #[test]
    fn star_does_not_cross_dirs() {
        let (_d, root) = repo();
        assert_eq!(names(&root, &ex(&root, "src/*.py")), Vec::<String>::new());
    }

    #[test]
    fn backslash_pattern() {
        let (_d, root) = repo();
        assert_eq!(names(&root, &ex(&root, r"src\*.rs")), ["src/a.rs"]);
    }

    #[test]
    fn absolute_pattern_other_casing() {
        let (_d, root) = repo();
        let s = root.to_string_lossy().into_owned();
        let mut chars = s.chars();
        let first = chars.next().unwrap();
        let flipped: char = if first.is_lowercase() {
            first.to_ascii_uppercase()
        } else {
            first.to_ascii_lowercase()
        };
        let pattern = format!("{flipped}{}/src/*.rs", chars.as_str());
        assert_eq!(names(&root, &ex(&root, &pattern)), ["src/a.rs"]);
    }

    #[test]
    fn space_in_dir() {
        let (_d, root) = repo();
        assert_eq!(names(&root, &ex(&root, "My Dir/*.cs")), ["My Dir/e.cs"]);
    }

    #[test]
    fn literal_missing_and_unsupported() {
        let (_d, root) = repo();
        let x = expand(&root, &["nope.rs".into(), "src/c.go".into()], 50);
        assert!(matches!(&x.entries[0], Entry::Missing(_)));
        assert!(matches!(&x.entries[1], Entry::Unsupported(_, e) if e == "go"));
    }

    #[test]
    fn empty_glob_counts_hidden() {
        let (_d, root) = repo();
        assert_eq!(ex(&root, "build/*.rs").empty_patterns, [("build/*.rs".to_string(), 1)]);
    }

    #[test]
    fn only_unsupported() {
        let (_d, root) = repo();
        assert_eq!(ex(&root, "src/*.go").unsupported_only, 1);
    }

    #[test]
    fn limit_and_total() {
        let (_d, root) = repo();
        let x = expand(&root, &["**/*".into()], 2);
        assert_eq!((x.entries.len(), x.total), (2, 4));
    }

    #[test]
    fn dotdot_relative() {
        let (_d, root) = repo();
        assert_eq!(resolve_file(&root, "src/../src/a.rs"), root.join("src").join("a.rs"));
    }

    #[test]
    fn project_dir_preferred() {
        let (_d, root) = repo();
        let ctx = Context { cwd: PathBuf::from(r"C:\"), project_dir: Some(root.clone()) };
        assert_eq!(repo_root(&ctx), root);
        let gone = Context {
            cwd: root.clone(),
            project_dir: Some(root.join("does").join("not").join("exist")),
        };
        assert_eq!(repo_root(&gone), root);
    }
}
