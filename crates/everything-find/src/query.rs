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

/// Excludes a folder named `name` and everything under it: `!\name\` drops
/// the contents, `!wfn:name` drops the folder entry itself.
fn exclude_folder(name: &str) -> String {
    if name.contains(' ') {
        format!("!\"\\{name}\\\" !wfn:\"{name}\"")
    } else {
        format!("!\\{name}\\ !wfn:{name}")
    }
}

/// A user exclude: a plain name excludes that folder like the defaults do;
/// anything with a slash or wildcard is an Everything path wildcard.
fn user_exclude(pattern: &str) -> Option<String> {
    let pattern = pattern.trim();
    if pattern.is_empty() {
        return None;
    }
    if pattern.contains(['/', '\\', '*', '?']) {
        Some(format!("!\"{}\"", pattern.replace('/', "\\")))
    } else {
        Some(exclude_folder(pattern))
    }
}

/// The user query is wrapped in `<…>` so an `|` inside it cannot escape the
/// root, kind and exclude filters.
pub fn build_query(
    user_query: &str,
    root: Option<&Path>,
    kind: Kind,
    default_excludes: bool,
    excludes: &[String],
) -> String {
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
                parts.push(exclude_folder(name));
            }
        }
    }
    parts.extend(excludes.iter().filter_map(|p| user_exclude(p)));
    parts.push(format!("<{user_query}>"));
    parts.join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_scope_plain() {
        assert_eq!(build_query("*.rs", None, Kind::Any, false, &[]), "<*.rs>");
    }

    #[test]
    fn repo_scope_full() {
        assert_eq!(
            build_query("foo | bar", Some(Path::new(r"C:\Source\app")), Kind::File, true, &[]),
            r#""C:\Source\app\" file: !\.git\ !wfn:.git !\node_modules\ !wfn:node_modules !\target\ !wfn:target !\bin\ !wfn:bin !\obj\ !wfn:obj <foo | bar>"#
        );
    }

    #[test]
    fn user_exclude_plain_name_hides_folder_and_contents() {
        let q = build_query("x", None, Kind::Any, false, &["dist".to_string()]);
        assert_eq!(q, r"!\dist\ !wfn:dist <x>");
    }

    #[test]
    fn user_exclude_path_glob_passes_through_with_backslashes() {
        let q = build_query("x", None, Kind::Any, false, &["*/worktrees/*".to_string()]);
        assert_eq!(q, r#"!"*\worktrees\*" <x>"#);
    }

    #[test]
    fn user_exclude_with_spaces_is_quoted() {
        let q = build_query("x", None, Kind::Any, false, &["My Dir".to_string()]);
        assert_eq!(q, r#"!"\My Dir\" !wfn:"My Dir" <x>"#);
    }

    #[test]
    fn blank_user_excludes_ignored() {
        assert_eq!(build_query("x", None, Kind::Any, false, &["  ".to_string()]), "<x>");
    }

    #[test]
    fn excludes_skip_folders_in_root() {
        let q = build_query("x", Some(Path::new(r"C:\Proj\BIN\app")), Kind::Any, true, &[]);
        assert!(!q.contains(r"!\bin\"), "{q}");
        assert!(q.contains(r"!\obj\"), "{q}");
        assert!(q.contains(r"!\node_modules\"), "{q}");
    }

    #[test]
    fn dir_kind() {
        assert!(build_query("x", None, Kind::Dir, false, &[]).starts_with("folder: "));
    }

    #[test]
    fn root_with_trailing_slash_not_doubled() {
        assert!(build_query("x", Some(Path::new(r"C:\a\")), Kind::Any, false, &[]).starts_with(r#""C:\a\" "#));
    }

    #[test]
    fn root_with_spaces_and_unicode() {
        assert!(
            build_query("x", Some(Path::new(r"C:\Users\Đorđe\My Repo")), Kind::Any, false, &[])
                .starts_with(r#""C:\Users\Đorđe\My Repo\" "#)
        );
    }
}
