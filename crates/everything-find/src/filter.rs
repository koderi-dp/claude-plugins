//! `.gitignore` filtering for repo-scope results. Knows nothing about Everything.

use ignore::Match;
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};

/// Strips `root` from `path`, comparing components case-insensitively (Windows
/// paths from Everything may differ in casing from the cwd). Returns the
/// relative remainder, or `None` when `path` is not under `root`.
pub fn strip_root_ci(path: &Path, root: &Path) -> Option<PathBuf> {
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

/// Lazily loads one matcher per directory, so nested `.gitignore` files apply
/// to their own subtree and deeper rules override shallower ones.
pub struct IgnoreFilter {
    root: PathBuf,
    matchers: HashMap<PathBuf, Option<Gitignore>>,
}

impl IgnoreFilter {
    pub fn new(root: &Path) -> IgnoreFilter {
        IgnoreFilter { root: root.to_path_buf(), matchers: HashMap::new() }
    }

    pub fn is_ignored(&mut self, path: &Path, is_dir: bool) -> bool {
        let Some(rel) = strip_root_ci(path, &self.root) else {
            return false;
        };
        // Always match against our own casing of the root, so every matcher's
        // "path is under my root" precondition holds.
        let abs = self.root.join(&rel);
        let mut dir = self.root.clone();
        let mut ignored = false;
        let parents: Vec<_> = rel.parent().map(|p| p.components().collect()).unwrap_or_default();
        for i in 0..=parents.len() {
            if i > 0 {
                dir.push(parents[i - 1]);
            }
            if let Some(m) = self.matcher(&dir) {
                match m.matched_path_or_any_parents(&abs, is_dir) {
                    Match::Ignore(_) => ignored = true,
                    Match::Whitelist(_) => ignored = false,
                    Match::None => {}
                }
            }
        }
        ignored
    }

    fn matcher(&mut self, dir: &Path) -> Option<&Gitignore> {
        let is_root = dir == self.root;
        self.matchers
            .entry(dir.to_path_buf())
            .or_insert_with(|| {
                let mut b = GitignoreBuilder::new(dir);
                b.case_insensitive(true).ok()?;
                let mut any = false;
                let mut files = vec![dir.join(".gitignore")];
                if is_root {
                    files.push(dir.join(r".git\info\exclude"));
                }
                for f in files.iter().filter(|f| f.is_file()) {
                    any |= b.add(f).is_none();
                }
                if !any {
                    return None;
                }
                b.build().ok()
            })
            .as_ref()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn fixture() -> (tempfile::TempDir, PathBuf, IgnoreFilter) {
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        fs::write(root.join(".gitignore"), "*.log\nbuild/\n!keep.log\n").unwrap();
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::write(root.join(r"sub\.gitignore"), "secret.txt\n").unwrap();
        let f = IgnoreFilter::new(&root);
        (dir, root, f)
    }

    #[test]
    fn ignores_by_glob() {
        let (_d, root, mut f) = fixture();
        assert!(f.is_ignored(&root.join("a.log"), false));
    }

    #[test]
    fn whitelist_wins() {
        let (_d, root, mut f) = fixture();
        assert!(!f.is_ignored(&root.join("keep.log"), false));
    }

    #[test]
    fn ignored_parent_dir() {
        let (_d, root, mut f) = fixture();
        assert!(f.is_ignored(&root.join(r"build\out\x.js"), false));
    }

    #[test]
    fn nested_gitignore() {
        let (_d, root, mut f) = fixture();
        assert!(f.is_ignored(&root.join(r"sub\secret.txt"), false));
        assert!(!f.is_ignored(&root.join("secret.txt"), false));
    }

    #[test]
    fn case_mismatched_root() {
        let (_d, root, mut f) = fixture();
        let upper = PathBuf::from(root.to_string_lossy().to_uppercase());
        assert!(f.is_ignored(&upper.join("A.LOG"), false));
    }

    #[test]
    fn no_gitignore_is_noop() {
        let dir = tempfile::tempdir().unwrap();
        let empty = dunce::canonicalize(dir.path()).unwrap();
        let mut f2 = IgnoreFilter::new(&empty);
        assert!(!f2.is_ignored(&empty.join("a.log"), false));
    }

    #[test]
    fn outside_root_not_ignored() {
        let (_d, _root, mut f) = fixture();
        assert!(!f.is_ignored(Path::new(r"Z:\elsewhere\a.log"), false));
    }

    #[test]
    fn strip_root_ci_relative() {
        assert_eq!(
            strip_root_ci(Path::new(r"C:\Source\App\src\a.rs"), Path::new(r"c:\source\app")),
            Some(PathBuf::from(r"src\a.rs"))
        );
        assert_eq!(strip_root_ci(Path::new(r"C:\Other\a.rs"), Path::new(r"C:\Source")), None);
    }
}
