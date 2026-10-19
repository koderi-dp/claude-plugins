//! Tests against a running Everything instance. Run with `cargo test -- --ignored`.

use everything_find::pipeline::{Context, FindParams, KindParam, SearchOpts, Searcher, SortKey, SortParam, run_find};
use everything_find::sdk::EverythingSdk;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

#[test]
#[ignore]
fn status_reports_running() {
    assert!(EverythingSdk.status().running);
}

#[test]
#[ignore]
fn finds_own_cargo_toml() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let query = format!("\"{}\\\" Cargo.toml", dir.display());
    let opts = SearchOpts { sort: SortKey::Name, offset: 0, max: 10, want_details: false };
    let page = EverythingSdk.search(&query, &opts).expect("search");
    let want = dir.join("Cargo.toml");
    assert!(page.entries.iter().any(|e| e.full_path == want && !e.is_dir), "entries: {:?}", page.entries);
}

/// A fresh folder with a space and non-ASCII characters in its name.
struct LiveDir(PathBuf);

impl LiveDir {
    fn new(test: &str) -> LiveDir {
        let raw = std::env::temp_dir().join(format!("ef-live-{}-{test}-Đ é", std::process::id()));
        let _ = fs::remove_dir_all(&raw);
        fs::create_dir_all(&raw).unwrap();
        LiveDir(dunce::canonicalize(&raw).unwrap())
    }

    fn ctx(&self) -> Context {
        Context { cwd: self.0.clone(), project_dir: None }
    }
}

impl Drop for LiveDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Polls until Everything has indexed `sentinel` (10 s timeout), returning the output.
fn wait_for(params: &FindParams, ctx: &Context, sentinel: &str) -> String {
    let start = Instant::now();
    loop {
        let out = run_find(params, ctx, &EverythingSdk).expect("valid params");
        // The zero-results message echoes the query, so it never counts as a hit.
        let found = !out.starts_with("0 matches") && out.contains(sentinel);
        if found || start.elapsed() > Duration::from_secs(10) {
            return out;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

fn params(query: &str) -> FindParams {
    FindParams { query: query.to_string(), ..Default::default() }
}

#[test]
#[ignore]
fn live_repo_scope_filters_gitignore() {
    let d = LiveDir::new("gi");
    fs::write(d.0.join(".gitignore"), "*.log\n").unwrap();
    fs::write(d.0.join("b.log"), "").unwrap();
    fs::write(d.0.join("a.rs"), "").unwrap();
    let out = wait_for(&params("*"), &d.ctx(), "a.rs");
    assert!(out.contains("a.rs"), "{out}");
    assert!(!out.contains("b.log"), "{out}");
}

#[test]
#[ignore]
fn live_include_ignored_shows_log() {
    let d = LiveDir::new("inc");
    fs::write(d.0.join(".gitignore"), "*.log\n").unwrap();
    fs::write(d.0.join("b.log"), "").unwrap();
    let out = wait_for(&FindParams { include_ignored: true, ..params("*.log") }, &d.ctx(), "b.log");
    assert!(out.contains("b.log"), "{out}");
}

#[test]
#[ignore]
fn live_sort_modified() {
    let d = LiveDir::new("sort");
    fs::write(d.0.join("old.txt"), "").unwrap();
    std::thread::sleep(Duration::from_millis(1100));
    fs::write(d.0.join("new.txt"), "").unwrap();
    let p = FindParams { sort: SortParam::Modified, ..params("*.txt") };
    let out = wait_for(&p, &d.ctx(), "new.txt");
    let (new, old) = (out.find("new.txt").expect(&out), out.find("old.txt").expect(&out));
    assert!(new < old, "{out}");
}

#[test]
#[ignore]
fn live_git_folder_itself_hidden() {
    let d = LiveDir::new("git");
    fs::create_dir_all(d.0.join(".git")).unwrap();
    fs::create_dir_all(d.0.join("src")).unwrap();
    fs::write(d.0.join(r"src\sentinel.txt"), "").unwrap();
    let out = wait_for(&FindParams { kind: KindParam::Dir, ..params("*") }, &d.ctx(), "src/");
    assert!(out.contains("src/"), "{out}");
    assert!(!out.contains(".git"), "{out}");
}

#[test]
#[ignore]
fn live_user_exclude_glob() {
    let d = LiveDir::new("excl");
    for sub in ["keep", r"worktrees\copy"] {
        fs::create_dir_all(d.0.join(sub)).unwrap();
        fs::write(d.0.join(sub).join("compose.yml"), "").unwrap();
    }
    let p = FindParams { exclude: vec!["*/worktrees/*".into()], ..params("compose.yml") };
    let out = wait_for(&p, &d.ctx(), "keep/");
    assert!(out.contains("keep/"), "{out}");
    assert!(!out.contains("worktrees"), "{out}");
}

#[test]
#[ignore]
fn live_date_query_lists_files_only() {
    let d = LiveDir::new("dm");
    fs::create_dir_all(d.0.join("sub")).unwrap();
    fs::write(d.0.join(r"sub\today.txt"), "").unwrap();
    let out = wait_for(&params("dm:today"), &d.ctx(), "today.txt");
    assert!(out.contains("today.txt"), "{out}");
    assert!(!out.contains("  sub/"), "folder entry listed: {out}");
}

#[test]
#[ignore]
fn live_long_path() {
    let d = LiveDir::new("long");
    let segment = "a".repeat(60);
    let mut deep = d.0.clone();
    for _ in 0..5 {
        deep.push(&segment);
    }
    fs::create_dir_all(&deep).unwrap();
    fs::write(deep.join("deep.txt"), "").unwrap();
    assert!(deep.join("deep.txt").as_os_str().len() > 300);
    let out = wait_for(&params("deep.txt"), &d.ctx(), "deep.txt");
    assert!(out.contains("deep.txt"), "{out}");
    assert!(out.contains(&format!("{segment}/{segment}/{segment}/{segment}/{segment}/")), "{out}");
}
