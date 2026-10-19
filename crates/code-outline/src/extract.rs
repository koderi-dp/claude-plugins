use std::collections::HashSet;

use tree_sitter::{Node, Parser, QueryCursor, StreamingIterator};

use crate::lang::Lang;

const SIGNATURE_CAP: usize = 160;
const MAX_ERROR_LINES: usize = 3;

#[derive(Debug, Clone, PartialEq)]
pub struct Symbol {
    /// Label such as `fn` or `async def`.
    pub kind: String,
    /// What the outline shows.
    pub name: String,
    /// Qualified-path segment; equals `name` except for Rust impls.
    pub key: String,
    /// 1-based inclusive, including leading docs and attributes.
    pub start_line: usize,
    pub end_line: usize,
    pub signature: String,
    pub children: Vec<Symbol>,
}

impl Symbol {
    pub fn label(&self) -> String {
        if self.name == self.kind {
            self.kind.clone()
        } else {
            format!("{} {}", self.kind, self.name)
        }
    }
}

pub struct Extracted {
    pub symbols: Vec<Symbol>,
    pub error_lines: Vec<usize>,
}

/// A symbol plus the byte range of its definition node, used for nesting.
struct Flat {
    start_byte: usize,
    end_byte: usize,
    symbol: Symbol,
}

pub fn extract(source: &str, lang: Lang) -> Extracted {
    let empty = || Extracted { symbols: Vec::new(), error_lines: Vec::new() };
    let mut parser = Parser::new();
    if parser.set_language(&lang.grammar()).is_err() {
        return empty();
    }
    let Some(tree) = parser.parse(source, None) else {
        return empty();
    };
    let root = tree.root_node();
    let bytes = source.as_bytes();
    let query = lang.query();
    let names = query.capture_names();

    let mut flats: Vec<Flat> = Vec::new();
    let mut seen: HashSet<(usize, usize)> = HashSet::new();
    let mut cursor = QueryCursor::new();
    let mut matches = cursor.matches(query, root, bytes);
    while let Some(m) = matches.next() {
        let mut item: Option<(Node, &str)> = None;
        let mut name_node: Option<Node> = None;
        for cap in m.captures() {
            let cname = names[cap.index as usize];
            if let Some(kind) = cname.strip_prefix("item.") {
                item = Some((cap.node, kind));
            } else if cname == "name" {
                name_node = Some(cap.node);
            }
        }
        let (Some((def, kind)), Some(name_node)) = (item, name_node) else {
            continue;
        };
        let range = (def.start_byte(), def.end_byte());
        if !seen.insert(range) {
            continue;
        }

        let range_node = match def.parent() {
            // Docs and decorators precede the wrapper, not the definition.
            Some(p) if matches!(p.kind(), "decorated_definition" | "export_statement") => p,
            _ => def,
        };
        let name_text = text(name_node, bytes);
        let (name, key) = if lang == Lang::Rust && def.kind() == "impl_item" {
            rust_impl_names(def, bytes)
        } else {
            (name_text.clone(), name_text)
        };
        flats.push(Flat {
            start_byte: def.start_byte(),
            end_byte: def.end_byte(),
            symbol: Symbol {
                kind: kind.to_string(),
                name,
                key,
                start_line: range_start_row(range_node, lang, bytes) + 1,
                end_line: range_node.end_position().row + 1,
                signature: signature(def, lang, bytes),
                children: Vec::new(),
            },
        });
    }

    Extracted { symbols: nest(flats), error_lines: error_lines(root) }
}

fn text(node: Node, bytes: &[u8]) -> String {
    node.utf8_text(bytes).unwrap_or("").to_string()
}

fn strip_generics(s: &str) -> String {
    let cut = s.find('<').map_or(s, |i| &s[..i]);
    cut.trim().to_string()
}

fn rust_impl_names(def: Node, bytes: &[u8]) -> (String, String) {
    let key = def
        .child_by_field_name("type")
        .map(|n| strip_generics(&text(n, bytes)))
        .unwrap_or_default();
    let name = match def.child_by_field_name("trait") {
        Some(t) => format!("{} for {key}", strip_generics(&text(t, bytes))),
        None => key.clone(),
    };
    (name, key)
}

/// 0-based row where the symbol's range starts, extended over directly
/// preceding attributes and doc comments (no blank line between).
fn range_start_row(range_node: Node, lang: Lang, bytes: &[u8]) -> usize {
    let mut start_row = range_node.start_position().row;
    let mut cur = range_node.prev_named_sibling();
    while let Some(sib) = cur {
        let kind = sib.kind();
        let accepted = lang.attr_kinds().contains(&kind)
            || (lang.comment_kinds().contains(&kind)
                && is_doc_comment(lang, sib.utf8_text(bytes).unwrap_or("")));
        // Rust line comments include their trailing newline, so the node ends
        // at column 0 of the next row.
        let end = sib.end_position();
        let end_row = if end.column == 0 && end.row > sib.start_position().row {
            end.row - 1
        } else {
            end.row
        };
        if !accepted || end_row + 1 < start_row {
            break;
        }
        start_row = sib.start_position().row;
        cur = sib.prev_named_sibling();
    }
    start_row
}

/// Doc comments start with a language doc prefix, but `////...` and `/***...`
/// banners and the empty block `/**/` are ordinary comments.
fn is_doc_comment(lang: Lang, text: &str) -> bool {
    lang.doc_prefixes().iter().any(|p| text.starts_with(p))
        && !text.starts_with("////")
        && !text.starts_with("/***")
        && text != "/**/"
}

fn signature(def: Node, lang: Lang, bytes: &[u8]) -> String {
    let skip = |k: &str| lang.attr_kinds().contains(&k) || lang.comment_kinds().contains(&k);
    let mut walk = def.walk();
    let start = def
        .children(&mut walk)
        .find(|c| !skip(c.kind()))
        .map_or(def.start_byte(), |c| c.start_byte());
    let end = body_start(def).unwrap_or_else(|| {
        bytes[def.start_byte()..def.end_byte()]
            .iter()
            .position(|&b| b == b'\n')
            .map_or(def.end_byte(), |i| def.start_byte() + i)
    });
    let raw = String::from_utf8_lossy(&bytes[start..end.max(start)]);
    let collapsed = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut s = collapsed.as_str();
    if let Some(rest) = s.strip_suffix('{').or_else(|| s.strip_suffix(':')) {
        s = rest.trim_end();
    }
    if s.chars().count() > SIGNATURE_CAP {
        let cut: String = s.chars().take(SIGNATURE_CAP).collect();
        format!("{cut}…")
    } else {
        s.to_string()
    }
}

/// Start byte of the first node (pre-order) that is the `body` field of its parent.
fn body_start(def: Node) -> Option<usize> {
    let mut cursor = def.walk();
    'outer: loop {
        let node = cursor.node();
        if node != def && cursor.field_name() == Some("body") {
            return Some(node.start_byte());
        }
        if cursor.goto_first_child() {
            continue;
        }
        loop {
            if cursor.node() == def {
                break 'outer;
            }
            if cursor.goto_next_sibling() {
                continue 'outer;
            }
            if !cursor.goto_parent() {
                break 'outer;
            }
        }
    }
    None
}

fn nest(mut flats: Vec<Flat>) -> Vec<Symbol> {
    flats.sort_by(|a, b| a.start_byte.cmp(&b.start_byte).then(b.end_byte.cmp(&a.end_byte)));
    // Each stack entry is (end_byte, symbol under construction).
    let mut stack: Vec<(usize, Symbol)> = Vec::new();
    let mut roots: Vec<Symbol> = Vec::new();
    fn close(stack: &mut Vec<(usize, Symbol)>, roots: &mut Vec<Symbol>) {
        if let Some((_, done)) = stack.pop() {
            match stack.last_mut() {
                Some((_, parent)) => parent.children.push(done),
                None => roots.push(done),
            }
        }
    }
    for f in flats {
        while stack.last().is_some_and(|(end, _)| *end <= f.start_byte) {
            close(&mut stack, &mut roots);
        }
        stack.push((f.end_byte, f.symbol));
    }
    while !stack.is_empty() {
        close(&mut stack, &mut roots);
    }
    roots
}

fn error_lines(root: Node) -> Vec<usize> {
    let mut rows = Vec::new();
    if root.has_error() {
        collect_errors(root, &mut rows);
    }
    rows
}

/// Pre-order walk (rows come out ascending) that stops at `MAX_ERROR_LINES`
/// distinct lines. Iterative so deeply nested files cannot overflow the stack.
fn collect_errors(root: Node, rows: &mut Vec<usize>) {
    let mut cursor = root.walk();
    loop {
        let node = cursor.node();
        if node.has_error() {
            if node.is_error() || node.is_missing() {
                let row = node.start_position().row + 1;
                if !rows.contains(&row) {
                    rows.push(row);
                    if rows.len() >= MAX_ERROR_LINES {
                        return;
                    }
                }
            }
            if cursor.goto_first_child() {
                continue;
            }
        }
        while !cursor.goto_next_sibling() {
            if !cursor.goto_parent() {
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn render(syms: &[Symbol], depth: usize, out: &mut Vec<String>) {
        for s in syms {
            out.push(format!(
                "{}{} {}-{}",
                "  ".repeat(depth),
                s.label(),
                s.start_line,
                s.end_line
            ));
            render(&s.children, depth + 1, out);
        }
    }

    fn tree(x: &Extracted) -> String {
        let mut out = Vec::new();
        render(&x.symbols, 0, &mut out);
        out.join("\n")
    }

    fn rs(src: &str) -> Extracted {
        extract(src, Lang::Rust)
    }

    const IMPL_SRC: &str = "impl Foo {\n    fn a() {}\n    fn b() {}\n}\n";

    #[test]
    fn nests_impl_methods() {
        assert_eq!(tree(&rs(IMPL_SRC)), "impl Foo 1-4\n  fn a 2-2\n  fn b 3-3");
    }

    #[test]
    fn impl_trait_for_generic() {
        let x = rs("impl<T: Clone> Display for Wrap<T> {\n    fn fmt(&self) {}\n}\n");
        let s = &x.symbols[0];
        assert_eq!(s.name, "Display for Wrap");
        assert_eq!(s.key, "Wrap");
        assert_eq!(s.label(), "impl Display for Wrap");
    }

    #[test]
    fn docs_and_attrs_extend_range() {
        let x = rs("/// doc\n#[test]\nfn t() {}\n");
        let s = &x.symbols[0];
        assert_eq!((s.start_line, s.end_line), (1, 3));
    }

    #[test]
    fn blank_line_stops_doc_walk() {
        let x = rs("/// orphan\n\nfn f() {}\n");
        assert_eq!(x.symbols[0].start_line, 3);
    }

    #[test]
    fn inner_doc_not_attached() {
        let x = rs("//! module docs\nfn f() {}\n");
        assert_eq!(x.symbols[0].start_line, 2);
    }

    #[test]
    fn plain_comment_not_attached() {
        let x = rs("// note\nfn f() {}\n");
        assert_eq!(x.symbols[0].start_line, 2);
    }

    #[test]
    fn signature_cut_at_body() {
        let x = rs("pub async fn find(&self,\n    p: Params)\n    -> Result<String, E> {\n    todo!()\n}\n");
        assert_eq!(
            x.symbols[0].signature,
            "pub async fn find(&self, p: Params) -> Result<String, E>"
        );
    }

    #[test]
    fn signature_capped_on_char_boundary() {
        let params = vec!["đ: u8"; 60].join(", ");
        let x = rs(&format!("fn f({params}) {{}}\n"));
        let sig = &x.symbols[0].signature;
        assert_eq!(sig.chars().count(), 161);
        assert!(sig.ends_with('…'));
    }

    #[test]
    fn crlf_lines() {
        let src = IMPL_SRC.replace('\n', "\r\n");
        let x = rs(&src);
        assert_eq!(tree(&x), "impl Foo 1-4\n  fn a 2-2\n  fn b 3-3");
        assert!(!x.symbols[0].signature.contains('\r'));
        assert!(!x.symbols[0].children[0].signature.contains('\r'));
    }

    #[test]
    fn non_ascii_before_symbol() {
        let x = rs("fn a() {\n    let s = \"😀 đ\";\n    fn b() {}\n}\n");
        let b = &x.symbols[0].children[0];
        assert_eq!(b.name, "b");
        assert_eq!(b.start_line, 3);
    }

    #[test]
    fn broken_file_still_outlines() {
        let x = rs("fn ok() {}\nfn broken( {\nstruct S;\n");
        let names: Vec<String> = flatten_names(&x.symbols);
        assert!(names.iter().any(|n| n == "ok") && names.iter().any(|n| n == "S"), "{names:?}");
        assert_eq!(x.error_lines.first(), Some(&2));
    }

    fn flatten_names(syms: &[Symbol]) -> Vec<String> {
        let mut v = Vec::new();
        for s in syms {
            v.push(s.name.clone());
            v.extend(flatten_names(&s.children));
        }
        v
    }

    #[test]
    fn kinds() {
        let x = rs("fn f() {}\nstruct S;\nenum E { A }\ntrait T {}\nimpl S {}\nmod m {}\nmacro_rules! mac { () => {} }\ntype A = u8;\nconst C: u8 = 1;\nstatic ST: u8 = 1;\n");
        let kinds: Vec<&str> = x.symbols.iter().map(|s| s.kind.as_str()).collect();
        assert_eq!(
            kinds,
            ["fn", "struct", "enum", "trait", "impl", "mod", "macro", "type", "const", "static"]
        );
    }

    #[test]
    fn test_module_nesting() {
        let x = rs("#[cfg(test)]\nmod tests {\n    #[test] fn t() {}\n}\n");
        assert_eq!(tree(&x), "mod tests 1-4\n  fn t 3-3");
    }

    fn ts(src: &str) -> Extracted {
        extract(src, Lang::TypeScript)
    }

    #[test]
    fn four_slashes_and_empty_block_are_not_docs() {
        assert_eq!(rs("//// banner
fn f() {}
").symbols[0].start_line, 2);
        assert_eq!(rs("/**/
fn f() {}
").symbols[0].start_line, 2);
        assert_eq!(rs("/***
 * banner
 */
fn f() {}
").symbols[0].start_line, 4);
        assert_eq!(rs("/** real */
fn f() {}
").symbols[0].start_line, 1);
        assert_eq!(rs("/// real
//// banner
fn f() {}
").symbols[0].start_line, 3);
    }

    #[test]
    fn duplicate_matches_yield_one_symbol() {
        let x = ts("const a = () => 1, b = () => 2;
");
        assert_eq!(tree(&x), "function a 1-1");
    }

    #[test]
    fn many_symbols_are_collected() {
        let src = "fn f() {}
".repeat(5000);
        assert_eq!(rs(&src).symbols.len(), 5000);
    }

    #[test]
    fn export_wrapper_takes_leading_docs() {
        let x = ts("/** d */
export function f() {}
");
        assert_eq!(tree(&x), "function f 1-2");
        let y = ts("/** d */
function g() {}
");
        assert_eq!(tree(&y), "function g 1-2");
    }

    #[test]
    fn error_lines_capped_at_three_distinct() {
        let src = "fn a( {
fn b( {
fn c( {
fn d( {
fn e( {
";
        let x = rs(src);
        assert!(x.error_lines.len() <= 3);
        assert!(x.error_lines.windows(2).all(|w| w[0] < w[1]));
        assert_eq!(x.error_lines.len(), 3);
    }

    #[test]
    fn deeply_nested_broken_file_does_not_overflow() {
        let src = format!("fn f() {{ let x = {} ;", "(".repeat(10_000));
        let x = rs(&src);
        assert!(!x.error_lines.is_empty() && x.error_lines.len() <= 3);
    }
}
