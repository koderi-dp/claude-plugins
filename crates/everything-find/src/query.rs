//! Builds the Everything search string from tool parameters.

use std::path::Path;

/// Folders excluded inside Everything so its totals stay close to accurate.
const DEFAULT_EXCLUDES: [&str; 5] = [".git", "node_modules", "target", "bin", "obj"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    File,
    Dir,
    Any,
}

/// The user query is wrapped in `<…>` so an `|` inside it cannot escape the
/// root, kind and exclude filters.
pub fn build_query(user_query: &str, root: Option<&Path>, kind: Kind, default_excludes: bool) -> String {
    let mut parts = Vec::new();
    let mut root_lower = String::new();
    if let Some(root) = root {
        let root = root.to_string_lossy();
        let root = root.trim_end_matches('\\');
        root_lower = format!("{}\\", root.to_lowercase());
        parts.push(format!("\"{root}\\\""));
    }
    match kind {
        Kind::File => parts.push("file:".to_string()),
        Kind::Dir => parts.push("folder:".to_string()),
        Kind::Any => {}
    }
    if default_excludes {
        // An exclude matching a folder in the root itself would hide everything.
        for name in DEFAULT_EXCLUDES {
            if !root_lower.contains(&format!("\\{name}\\")) {
                parts.push(format!("!\\{name}\\"));
            }
        }
    }
    parts.push(format!("<{user_query}>"));
    parts.join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_scope_plain() {
        assert_eq!(build_query("*.rs", None, Kind::Any, false), "<*.rs>");
    }

    #[test]
    fn repo_scope_full() {
        assert_eq!(
            build_query("foo | bar", Some(Path::new(r"C:\Source\app")), Kind::File, true),
            r#""C:\Source\app\" file: !\.git\ !\node_modules\ !\target\ !\bin\ !\obj\ <foo | bar>"#
        );
    }

    #[test]
    fn excludes_skip_folders_in_root() {
        let q = build_query("x", Some(Path::new(r"C:\Proj\BIN\app")), Kind::Any, true);
        assert!(!q.contains(r"!\bin\"), "{q}");
        assert!(q.contains(r"!\obj\"), "{q}");
        assert!(q.contains(r"!\node_modules\"), "{q}");
    }

    #[test]
    fn dir_kind() {
        assert!(build_query("x", None, Kind::Dir, false).starts_with("folder: "));
    }

    #[test]
    fn root_with_trailing_slash_not_doubled() {
        assert!(build_query("x", Some(Path::new(r"C:\a\")), Kind::Any, false).starts_with(r#""C:\a\" "#));
    }

    #[test]
    fn root_with_spaces_and_unicode() {
        assert!(
            build_query("x", Some(Path::new(r"C:\Users\Đorđe\My Repo")), Kind::Any, false)
                .starts_with(r#""C:\Users\Đorđe\My Repo\" "#)
        );
    }
}
