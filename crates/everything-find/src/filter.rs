//! `.gitignore` filtering for repo-scope results. Knows nothing about Everything.

use ignore::Match;
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::time::SystemTime;

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
    nested_repo: HashMap<PathBuf, bool>,
    /// Ignore files read so far, with the modified time seen, for `is_stale`.
    loaded: Vec<(PathBuf, Option<SystemTime>)>,
}

fn modified(path: &Path) -> Option<SystemTime> {
    std::fs::metadata(path).and_then(|m| m.modified()).ok()
}

impl IgnoreFilter {
    pub fn new(root: &Path) -> IgnoreFilter {
        IgnoreFilter {
            root: root.to_path_buf(),
            matchers: HashMap::new(),
            nested_repo: HashMap::new(),
            loaded: Vec::new(),
        }
    }

    /// True once any ignore file this filter has read was changed or removed.
    /// New ignore files are not noticed; callers bound reuse with a max age.
    pub fn is_stale(&self) -> bool {
        self.loaded.iter().any(|(path, seen)| modified(path) != *seen)
    }

    pub fn is_ignored(&mut self, path: &Path, is_dir: bool) -> bool {
        let Some(rel) = strip_root_ci(path, &self.root) else {
            return false;
        };
        // Always match against our own casing of the root, so every matcher's
        // "path is under my root" precondition holds.
        let abs = self.root.join(&rel);
        if self.inside_nested_repo(&rel, is_dir) {
            return true;
        }
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

    /// Like git, treat a folder below the root that has its own `.git` (a
    /// worktree's `.git` file or a nested repo's `.git` folder) as a separate
    /// repo: it and everything under it are hidden.
    fn inside_nested_repo(&mut self, rel: &Path, is_dir: bool) -> bool {
        let components: Vec<_> = rel.components().collect();
        let dirs = if is_dir { components.len() } else { components.len().saturating_sub(1) };
        let mut dir = self.root.clone();
        for component in &components[..dirs] {
            dir.push(component);
            let nested = *self.nested_repo.entry(dir.clone()).or_insert_with(|| dir.join(".git").exists());
            if nested {
                return true;
            }
        }
        false
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
                    self.loaded.push((f.clone(), modified(f)));
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
    fn fresh_filter_is_not_stale() {
        let (_d, root, mut f) = fixture();
        f.is_ignored(&root.join(r"sub\x.txt"), false);
        assert!(!f.is_stale());
    }

    #[test]
    fn edited_gitignore_makes_filter_stale() {
        let (_d, root, mut f) = fixture();
        f.is_ignored(&root.join(r"sub\x.txt"), false);
        let file = fs::OpenOptions::new().write(true).open(root.join(r"sub\.gitignore")).unwrap();
        file.set_modified(std::time::SystemTime::now() + std::time::Duration::from_secs(5)).unwrap();
        assert!(f.is_stale());
    }

    #[test]
    fn nested_worktree_hidden() {
        let (_d, root, mut f) = fixture();
        let wt = root.join(r"wt\copy");
        fs::create_dir_all(wt.join("src")).unwrap();
        fs::write(wt.join(".git"), "gitdir: elsewhere\n").unwrap();
        assert!(f.is_ignored(&wt.join(r"src\main.rs"), false));
        assert!(f.is_ignored(&wt, true));
        assert!(!f.is_ignored(&root.join(r"wt\other.rs"), false));
    }

    #[test]
    fn nested_repo_dir_hidden() {
        let (_d, root, mut f) = fixture();
        fs::create_dir_all(root.join(r"vendored\.git")).unwrap();
        assert!(f.is_ignored(&root.join(r"vendored\lib.rs"), false));
    }

    #[test]
    fn root_own_git_not_treated_as_nested() {
        let (_d, root, mut f) = fixture();
        fs::create_dir_all(root.join(".git")).unwrap();
        assert!(!f.is_ignored(&root.join(r"src\a.rs"), false));
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
