//! The `find` pipeline: resolve root → build query → paged search → filter → format.

use crate::filter::{IgnoreFilter, strip_root_ci};
use crate::format::{Header, render};
use crate::query::{Kind, build_query};
use schemars::JsonSchema;
use serde::Deserialize;
use std::path::{Path, PathBuf};

const MAX_PAGES: u32 = 10;
const NOT_RUNNING: &str = "Everything is not running — start it, or use Glob instead.";
const QUERY_HINT: &str = "Hint: wrap paths in quotes; use | for OR, ! for NOT, ext:rs, dm:today.";

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    #[default]
    Repo,
    All,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum KindParam {
    File,
    Dir,
    #[default]
    Any,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum SortParam {
    #[default]
    Name,
    Modified,
    Size,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct FindParams {
    /// Everything search syntax, e.g. `*.tsx`, `config ext:json`, `dm:today`.
    pub query: String,
    /// `repo` (default) searches the current repo; `all` searches every drive.
    #[serde(default)]
    pub scope: Scope,
    /// Restrict to this folder (absolute, or relative to the repo root).
    #[serde(default)]
    pub path: Option<String>,
    /// `file`, `dir` or `any` (default).
    #[serde(default)]
    pub kind: KindParam,
    /// Max results, 1–500 (default 50).
    #[serde(default = "default_limit")]
    pub limit: u32,
    /// `name` (default), `modified` (newest first) or `size` (largest first).
    #[serde(default)]
    pub sort: SortParam,
    /// Include size and modified date per result.
    #[serde(default)]
    pub details: bool,
    /// Repo scope only: don't hide .gitignore'd and build/vendor folders.
    #[serde(default)]
    pub include_ignored: bool,
}

fn default_limit() -> u32 {
    50
}

impl Default for FindParams {
    fn default() -> Self {
        FindParams {
            query: String::new(),
            scope: Scope::Repo,
            path: None,
            kind: KindParam::Any,
            limit: default_limit(),
            sort: SortParam::Name,
            details: false,
            include_ignored: false,
        }
    }
}

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

/// Canonical so 8.3 short names and `..` match the long paths Everything returns.
pub(crate) fn repo_root(ctx: &Context) -> PathBuf {
    let dir = match &ctx.project_dir {
        Some(dir) if dir.is_dir() => dir.clone(),
        _ => ctx.cwd.clone(),
    };
    dunce::canonicalize(&dir).unwrap_or(dir)
}

/// The nearest ancestor (inclusive) holding `.git`, so a session started in a
/// subfolder still honours the repo's top-level `.gitignore`.
fn git_root(start: &Path) -> Option<PathBuf> {
    start.ancestors().find(|d| d.join(".git").exists()).map(Path::to_path_buf)
}

/// `Err` carries the full user-facing "not indexed" message.
pub fn resolve_root(params: &FindParams, ctx: &Context) -> Result<Option<PathBuf>, String> {
    match &params.path {
        Some(path) => {
            let candidate = Path::new(path);
            let joined =
                if candidate.is_absolute() { candidate.to_path_buf() } else { repo_root(ctx).join(candidate) };
            dunce::canonicalize(&joined)
                .map(Some)
                .map_err(|_| format!("{path} is not indexed by Everything (non-NTFS or excluded) — use Glob."))
        }
        None => Ok(match params.scope {
            Scope::Repo => Some(repo_root(ctx)),
            Scope::All => None,
        }),
    }
}

/// `Err` means invalid params only; every other outcome is user-facing text.
pub fn run_find(params: &FindParams, ctx: &Context, s: &dyn Searcher) -> Result<String, String> {
    if !(1..=500).contains(&params.limit) {
        return Err("limit must be between 1 and 500".to_string());
    }
    if params.query.trim().is_empty() {
        return Err("query must not be empty".to_string());
    }
    let root = match resolve_root(params, ctx) {
        Ok(root) => root,
        Err(msg) => return Ok(msg),
    };
    let status = s.status();
    if !status.running {
        return Ok(NOT_RUNNING.to_string());
    }

    let filtering = params.scope == Scope::Repo && !params.include_ignored;
    let mut filter = match (&root, filtering) {
        (Some(search_root), true) => {
            let repo = repo_root(ctx);
            let base = if strip_root_ci(search_root, &repo).is_some() { repo } else { search_root.clone() };
            Some(IgnoreFilter::new(&git_root(&base).unwrap_or(base)))
        }
        _ => None,
    };

    let kind = match params.kind {
        KindParam::File => Kind::File,
        KindParam::Dir => Kind::Dir,
        KindParam::Any => Kind::Any,
    };
    let query = build_query(&params.query, root.as_deref(), kind, filtering);
    let sort = match params.sort {
        SortParam::Name => SortKey::Name,
        SortParam::Modified => SortKey::Modified,
        SortParam::Size => SortKey::Size,
    };
    let limit = params.limit as usize;
    let mut opts = SearchOpts { sort, offset: 0, max: (params.limit * 2).max(100), want_details: params.details };

    let mut kept: Vec<Entry> = Vec::new();
    let mut hidden: u32 = 0;
    let mut total: u32 = 0;
    let mut examined_all = false;
    let mut pages = 0;
    'paging: while pages < MAX_PAGES {
        let page = match s.search(&query, &opts) {
            Ok(page) => page,
            Err(SdkError::NotRunning) => return Ok(NOT_RUNNING.to_string()),
            Err(SdkError::Rejected(reason)) => {
                return Ok(format!("Everything rejected the query: {reason}\n{QUERY_HINT}"));
            }
        };
        pages += 1;
        total = page.total;
        let n = page.entries.len() as u32;
        for entry in page.entries {
            if kept.len() == limit {
                // Stopped mid-page: the rest of this page is unexamined.
                break 'paging;
            }
            let ignored = filter.as_mut().is_some_and(|f| f.is_ignored(&entry.full_path, entry.is_dir));
            if ignored {
                hidden += 1;
            } else {
                kept.push(entry);
            }
        }
        opts.offset += n;
        if n == 0 || opts.offset >= total {
            examined_all = true;
            break;
        }
        if kept.len() == limit {
            break;
        }
    }
    let page_capped = pages == MAX_PAGES && !examined_all && kept.len() < limit;

    let root_label = root.as_ref().map(|r| r.display().to_string()).unwrap_or_else(|| "all drives".to_string());
    let hidden_note = if hidden > 0 {
        format!(" ({hidden} hidden by .gitignore — retry with include_ignored: true)")
    } else if filtering {
        " (build/vendor folders excluded — retry with include_ignored: true)".to_string()
    } else {
        String::new()
    };
    if kept.is_empty() {
        let warning = if status.db_loaded { "" } else { "Everything is still indexing; results may be incomplete.\n" };
        return Ok(format!("{warning}0 matches for {} in {root_label}{hidden_note}", params.query));
    }

    let (count, count_is_upper_bound) = match (hidden, examined_all) {
        (0, _) => (total, false),
        (_, true) => (total.saturating_sub(hidden), false),
        (_, false) => (total.saturating_sub(hidden), true),
    };
    let scope_label = match (params.scope, &root) {
        (Scope::Repo, Some(r)) => format!("repo {}", r.display()),
        (_, Some(r)) => r.display().to_string(),
        (_, None) => "all drives".to_string(),
    };
    let header = Header {
        count,
        count_is_upper_bound,
        shown: kept.len(),
        scope_label,
        page_capped,
        hidden_by_ignore: hidden,
        indexing: !status.db_loaded,
    };
    Ok(render(&kept, &header, root.as_deref(), params.details))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SortKey {
    Name,
    Modified,
    Size,
}

#[derive(Debug, Clone)]
pub struct SearchOpts {
    pub sort: SortKey,
    pub offset: u32,
    pub max: u32,
    pub want_details: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    pub full_path: PathBuf,
    pub is_dir: bool,
    pub size: Option<u64>,
    /// Unix seconds.
    pub modified: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct SearchPage {
    pub entries: Vec<Entry>,
    pub total: u32,
}

#[derive(Debug, Clone, Copy)]
pub struct Status {
    pub running: bool,
    pub db_loaded: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum SdkError {
    NotRunning,
    Rejected(String),
}

pub trait Searcher: Send + Sync {
    fn search(&self, query: &str, opts: &SearchOpts) -> Result<SearchPage, SdkError>;
    fn status(&self) -> Status;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;
    use std::sync::Mutex;

    struct FakeSearcher {
        entries: Vec<Entry>,
        status: Status,
        err: Option<SdkError>,
        calls: Mutex<Vec<(String, SearchOpts)>>,
    }

    impl FakeSearcher {
        fn new(entries: Vec<Entry>) -> Self {
            FakeSearcher {
                entries,
                status: Status { running: true, db_loaded: true },
                err: None,
                calls: Mutex::new(Vec::new()),
            }
        }
        fn calls(&self) -> usize {
            self.calls.lock().unwrap().len()
        }
        fn last_query(&self) -> String {
            self.calls.lock().unwrap().last().unwrap().0.clone()
        }
        fn last_opts(&self) -> SearchOpts {
            self.calls.lock().unwrap().last().unwrap().1.clone()
        }
    }

    impl Searcher for FakeSearcher {
        fn search(&self, query: &str, opts: &SearchOpts) -> Result<SearchPage, SdkError> {
            self.calls.lock().unwrap().push((query.to_string(), opts.clone()));
            if let Some(e) = &self.err {
                return Err(e.clone());
            }
            let start = (opts.offset as usize).min(self.entries.len());
            let end = (start + opts.max as usize).min(self.entries.len());
            Ok(SearchPage { entries: self.entries[start..end].to_vec(), total: self.entries.len() as u32 })
        }
        fn status(&self) -> Status {
            self.status
        }
    }

    fn file(p: &Path) -> Entry {
        Entry { full_path: p.to_path_buf(), is_dir: false, size: None, modified: None }
    }

    /// Temp repo whose .gitignore ignores `build/` and `*.log`.
    fn repo() -> (tempfile::TempDir, PathBuf, Context) {
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        fs::write(root.join(".gitignore"), "build/\n*.log\n").unwrap();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::create_dir_all(root.join("tests")).unwrap();
        let ctx = Context { cwd: root.clone(), project_dir: None };
        (dir, root, ctx)
    }

    fn params(query: &str) -> FindParams {
        FindParams { query: query.to_string(), ..Default::default() }
    }

    const NOT_RUNNING: &str = "Everything is not running — start it, or use Glob instead.";

    #[test]
    fn not_running() {
        let (_d, _root, ctx) = repo();
        let mut fake = FakeSearcher::new(vec![]);
        fake.status.running = false;
        assert_eq!(run_find(&params("*.rs"), &ctx, &fake), Ok(NOT_RUNNING.to_string()));
    }

    #[test]
    fn search_ipc_failure_is_not_running() {
        let (_d, _root, ctx) = repo();
        let mut fake = FakeSearcher::new(vec![]);
        fake.err = Some(SdkError::NotRunning);
        assert_eq!(run_find(&params("*.rs"), &ctx, &fake), Ok(NOT_RUNNING.to_string()));
    }

    #[test]
    fn limit_out_of_range() {
        let (_d, _root, ctx) = repo();
        let fake = FakeSearcher::new(vec![]);
        assert!(run_find(&FindParams { limit: 0, ..params("x") }, &ctx, &fake).is_err());
        assert!(run_find(&FindParams { limit: 501, ..params("x") }, &ctx, &fake).is_err());
    }

    #[test]
    fn empty_query_rejected() {
        let (_d, _root, ctx) = repo();
        assert!(run_find(&params("  "), &ctx, &FakeSearcher::new(vec![])).is_err());
    }

    #[test]
    fn pages_until_limit() {
        let (_d, root, ctx) = repo();
        let mut entries: Vec<Entry> = (0..150).map(|i| file(&root.join(format!(r"build\f{i}.rs")))).collect();
        entries.extend((0..150).map(|i| file(&root.join(format!(r"src\f{i}.rs")))));
        let fake = FakeSearcher::new(entries);
        let out = run_find(&FindParams { limit: 120, ..params("*.rs") }, &ctx, &fake).unwrap();
        assert_eq!(out.matches(".rs").count(), 120, "{out}");
        assert_eq!(fake.calls(), 2);
        assert_eq!(fake.last_opts().max, 240);
        assert!(!out.contains("build/"));
    }

    #[test]
    fn exact_count_when_all_consumed() {
        let (_d, root, ctx) = repo();
        let entries = vec![file(&root.join("a.log")), file(&root.join(r"src\a.rs"))];
        let out = run_find(&params("a"), &ctx, &FakeSearcher::new(entries)).unwrap();
        assert!(out.starts_with("1 matches, showing 1 — repo "), "{out}");
        assert!(out.contains("(1 hidden by .gitignore"));
    }

    #[test]
    fn page_cap_at_ten() {
        let (_d, root, ctx) = repo();
        let mut entries: Vec<Entry> = (0..5000).map(|i| file(&root.join(format!("f{i}.log")))).collect();
        entries[50] = file(&root.join(r"src\keep.rs"));
        let fake = FakeSearcher::new(entries);
        let out = run_find(&FindParams { limit: 2, ..params("*") }, &ctx, &fake).unwrap();
        assert!(out.contains("(scan capped at 10 pages)"), "{out}");
        assert!(out.starts_with("≤4001 matches, showing 1"), "{out}");
        assert_eq!(fake.calls(), 10);
    }

    #[test]
    fn zero_after_filter_hint() {
        let (_d, root, ctx) = repo();
        let fake = FakeSearcher::new(vec![file(&root.join("a.log")), file(&root.join("b.log"))]);
        let out = run_find(&params("*.log"), &ctx, &fake).unwrap();
        assert_eq!(
            out,
            format!(
                "0 matches for *.log in {} (2 hidden by .gitignore — retry with include_ignored: true)",
                root.display()
            )
        );
    }

    #[test]
    fn zero_plain() {
        let fake = FakeSearcher::new(vec![]);
        let ctx = Context { cwd: PathBuf::from(r"C:\"), project_dir: None };
        let out = run_find(&FindParams { scope: Scope::All, ..params("nothing") }, &ctx, &fake).unwrap();
        assert_eq!(out, "0 matches for nothing in all drives");
    }

    #[test]
    fn include_ignored_disables() {
        let (_d, root, ctx) = repo();
        let fake = FakeSearcher::new(vec![file(&root.join("a.log"))]);
        let out = run_find(&FindParams { include_ignored: true, ..params("*.log") }, &ctx, &fake).unwrap();
        assert!(!fake.last_query().contains(r"!\node_modules\"));
        assert!(out.contains("a.log"));
    }

    #[test]
    fn repo_scope_query_has_root_and_excludes() {
        let (_d, root, ctx) = repo();
        let fake = FakeSearcher::new(vec![]);
        run_find(&FindParams { kind: KindParam::File, ..params("*.rs") }, &ctx, &fake).unwrap();
        let q = fake.last_query();
        assert!(q.starts_with(&format!("\"{}\\\" file: ", root.display())), "{q}");
        assert!(q.contains(r"!\node_modules\"));
    }

    #[test]
    fn rejected_passthrough() {
        let (_d, _root, ctx) = repo();
        let mut fake = FakeSearcher::new(vec![]);
        fake.err = Some(SdkError::Rejected("Everything error code 9".into()));
        let out = run_find(&params("<<"), &ctx, &fake).unwrap();
        assert!(out.starts_with("Everything rejected the query: Everything error code 9\nHint: "), "{out}");
    }

    #[test]
    fn relative_path_normalised() {
        let (_d, root, ctx) = repo();
        let p = FindParams { path: Some("src/../tests".into()), ..params("x") };
        assert_eq!(resolve_root(&p, &ctx).unwrap(), Some(root.join("tests")));
    }

    const NOPE: &str = "nope is not indexed by Everything (non-NTFS or excluded) — use Glob.";

    #[test]
    fn missing_path_message() {
        let (_d, _root, ctx) = repo();
        let p = FindParams { path: Some("nope".into()), ..params("x") };
        assert_eq!(resolve_root(&p, &ctx).unwrap_err(), NOPE);
    }

    #[test]
    fn missing_path_reported_by_run_find() {
        let (_d, _root, ctx) = repo();
        let p = FindParams { path: Some("nope".into()), ..params("x") };
        assert_eq!(run_find(&p, &ctx, &FakeSearcher::new(vec![])), Ok(NOPE.to_string()));
    }

    #[test]
    fn project_dir_preferred() {
        let (_d, root, _ctx) = repo();
        let ctx = Context { cwd: PathBuf::from(r"C:\"), project_dir: Some(root.clone()) };
        assert_eq!(repo_root(&ctx), root);
        let gone = Context { cwd: root.clone(), project_dir: Some(PathBuf::from(r"C:\does\not\exist")) };
        assert_eq!(repo_root(&gone), root);
    }

    #[test]
    fn sort_maps() {
        let (_d, _root, ctx) = repo();
        let fake = FakeSearcher::new(vec![]);
        run_find(&FindParams { sort: SortParam::Modified, ..params("x") }, &ctx, &fake).unwrap();
        assert_eq!(fake.last_opts().sort, SortKey::Modified);
    }

    #[test]
    fn repo_root_is_canonicalized() {
        let (_d, root, _ctx) = repo();
        let ctx = Context { cwd: root.join(r"src\.."), project_dir: None };
        assert_eq!(repo_root(&ctx), root);
        // tempfile hands out the raw (8.3 short-name on this machine) %TEMP% form.
        let raw = tempfile::tempdir().unwrap();
        let long = dunce::canonicalize(raw.path()).unwrap();
        assert_eq!(repo_root(&Context { cwd: raw.path().to_path_buf(), project_dir: None }), long);
    }

    #[test]
    fn zero_with_default_excludes_hints_include_ignored() {
        let (_d, _root, ctx) = repo();
        let out = run_find(&params("nothing"), &ctx, &FakeSearcher::new(vec![])).unwrap();
        assert!(out.ends_with(" (build/vendor folders excluded — retry with include_ignored: true)"), "{out}");
    }

    #[test]
    fn subfolder_session_applies_git_root_gitignore() {
        let (_d, root, _ctx) = repo();
        fs::create_dir_all(root.join(".git")).unwrap();
        let ctx = Context { cwd: root.join("src"), project_dir: None };
        let fake = FakeSearcher::new(vec![file(&root.join(r"src\a.log")), file(&root.join(r"src\b.rs"))]);
        let out = run_find(&params("*"), &ctx, &fake).unwrap();
        assert!(out.contains("b.rs"), "{out}");
        assert!(!out.contains("a.log"), "{out}");
    }

    #[test]
    fn zero_results_keep_indexing_warning() {
        let (_d, _root, ctx) = repo();
        let mut fake = FakeSearcher::new(vec![]);
        fake.status.db_loaded = false;
        let out = run_find(&params("a"), &ctx, &fake).unwrap();
        assert!(out.starts_with("Everything is still indexing; results may be incomplete.\n0 matches"), "{out}");
    }

    #[test]
    fn indexing_warning_passed_to_output() {
        let (_d, root, ctx) = repo();
        let mut fake = FakeSearcher::new(vec![file(&root.join(r"src\a.rs"))]);
        fake.status.db_loaded = false;
        let out = run_find(&params("a"), &ctx, &fake).unwrap();
        assert!(out.starts_with("Everything is still indexing; results may be incomplete.\n"));
    }
}
