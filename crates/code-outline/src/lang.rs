use std::path::Path;
use std::sync::OnceLock;

use tree_sitter::{Language, Query};

pub const SUPPORTED: &str = "rs, ts, tsx, js, jsx, mjs, cjs, py, cs";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Lang {
    Rust,
    TypeScript,
    Tsx,
    JavaScript,
    Python,
    CSharp,
}

impl Lang {
    pub fn from_path(path: &Path) -> Option<Lang> {
        let ext = path.extension()?.to_str()?.to_ascii_lowercase();
        match ext.as_str() {
            "rs" => Some(Lang::Rust),
            "ts" | "mts" | "cts" => Some(Lang::TypeScript),
            "tsx" => Some(Lang::Tsx),
            "js" | "jsx" | "mjs" | "cjs" => Some(Lang::JavaScript),
            "py" | "pyi" => Some(Lang::Python),
            "cs" => Some(Lang::CSharp),
            _ => None,
        }
    }

    pub fn grammar(self) -> Language {
        match self {
            Lang::Rust => tree_sitter_rust::LANGUAGE.into(),
            Lang::TypeScript => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
            Lang::Tsx => tree_sitter_typescript::LANGUAGE_TSX.into(),
            Lang::JavaScript => tree_sitter_javascript::LANGUAGE.into(),
            Lang::Python => tree_sitter_python::LANGUAGE.into(),
            Lang::CSharp => tree_sitter_c_sharp::LANGUAGE.into(),
        }
    }

    /// Compiled outline query, built once per language. Panics on an invalid
    /// query, which is a build bug caught by tests.
    pub fn query(self) -> &'static Query {
        static RUST: OnceLock<Query> = OnceLock::new();
        static TYPESCRIPT: OnceLock<Query> = OnceLock::new();
        static TSX: OnceLock<Query> = OnceLock::new();
        static JAVASCRIPT: OnceLock<Query> = OnceLock::new();
        static PYTHON: OnceLock<Query> = OnceLock::new();
        static CSHARP: OnceLock<Query> = OnceLock::new();

        let (cell, source) = match self {
            Lang::Rust => (&RUST, include_str!("../queries/rust.scm")),
            Lang::TypeScript => (&TYPESCRIPT, include_str!("../queries/typescript.scm")),
            Lang::Tsx => (&TSX, include_str!("../queries/typescript.scm")),
            Lang::JavaScript => (&JAVASCRIPT, include_str!("../queries/javascript.scm")),
            Lang::Python => (&PYTHON, include_str!("../queries/python.scm")),
            Lang::CSharp => (&CSHARP, include_str!("../queries/csharp.scm")),
        };
        cell.get_or_init(|| {
            Query::new(&self.grammar(), source)
                .unwrap_or_else(|e| panic!("invalid {self:?} outline query: {e}"))
        })
    }

    pub fn doc_prefixes(self) -> &'static [&'static str] {
        match self {
            Lang::Rust => &["///", "/**"],
            Lang::TypeScript | Lang::Tsx | Lang::JavaScript => &["/**"],
            Lang::CSharp => &["///"],
            Lang::Python => &[],
        }
    }

    pub fn attr_kinds(self) -> &'static [&'static str] {
        match self {
            Lang::Rust => &["attribute_item"],
            Lang::TypeScript | Lang::Tsx | Lang::JavaScript => &["decorator"],
            Lang::CSharp => &["attribute_list"],
            Lang::Python => &[],
        }
    }

    pub fn comment_kinds(self) -> &'static [&'static str] {
        match self {
            Lang::Rust => &["line_comment", "block_comment"],
            _ => &["comment"],
        }
    }

    pub fn sep(self) -> &'static str {
        match self {
            Lang::Rust => "::",
            _ => ".",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL: [Lang; 6] = [
        Lang::Rust,
        Lang::TypeScript,
        Lang::Tsx,
        Lang::JavaScript,
        Lang::Python,
        Lang::CSharp,
    ];

    #[test]
    fn ext_mapping() {
        assert_eq!(Lang::from_path(Path::new("a/b.RS")), Some(Lang::Rust));
        assert_eq!(Lang::from_path(Path::new("x.mts")), Some(Lang::TypeScript));
        assert_eq!(Lang::from_path(Path::new("x.tsx")), Some(Lang::Tsx));
        assert_eq!(Lang::from_path(Path::new("x.cjs")), Some(Lang::JavaScript));
        assert_eq!(Lang::from_path(Path::new("x.pyi")), Some(Lang::Python));
        assert_eq!(Lang::from_path(Path::new("x.cs")), Some(Lang::CSharp));
        assert_eq!(Lang::from_path(Path::new("x.go")), None);
        assert_eq!(Lang::from_path(Path::new("Makefile")), None);
    }

    #[test]
    fn every_grammar_parses() {
        for l in ALL {
            let src = match l {
                Lang::Rust => "fn main() {}",
                Lang::TypeScript | Lang::Tsx => "const x: number = 1;",
                Lang::JavaScript => "const x = 1;",
                Lang::Python => "x = 1",
                Lang::CSharp => "class A {}",
            };
            let mut parser = tree_sitter::Parser::new();
            parser.set_language(&l.grammar()).unwrap();
            let tree = parser.parse(src, None).unwrap();
            assert!(!tree.root_node().has_error(), "{l:?} failed to parse");
        }
    }

    #[test]
    fn every_query_compiles() {
        for l in ALL {
            let _ = l.query();
        }
    }
}
