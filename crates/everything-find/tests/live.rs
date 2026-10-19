//! Tests against a running Everything instance. Run with `cargo test -- --ignored`.

use everything_find::pipeline::{SearchOpts, Searcher, SortKey};
use everything_find::sdk::EverythingSdk;
use std::path::Path;

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
    assert!(
        page.entries.iter().any(|e| e.full_path == want && !e.is_dir),
        "entries: {:?}",
        page.entries
    );
}
