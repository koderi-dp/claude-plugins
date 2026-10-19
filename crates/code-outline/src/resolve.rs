use crate::extract::Symbol;
use crate::lang::Lang;

const MAX_SUGGESTIONS: usize = 5;
const MAX_DISTANCE: usize = 3;

#[derive(Debug)]
pub struct Hit<'a> {
    pub symbol: &'a Symbol,
    /// Container keys plus own key, joined with `Lang::sep`.
    pub qualified: String,
}

#[derive(Debug)]
pub enum Resolution<'a> {
    Found(Hit<'a>),
    Ambiguous(Vec<Hit<'a>>),
    NotFound(Vec<String>),
}

/// A symbol with the keys of its ancestors and itself, in document order.
struct Entry<'a> {
    symbol: &'a Symbol,
    keys: Vec<&'a str>,
}

impl Entry<'_> {
    fn own_key(&self) -> &str {
        self.keys.last().copied().unwrap_or("")
    }
}

fn flatten<'a>(symbols: &'a [Symbol], keys: &mut Vec<&'a str>, out: &mut Vec<Entry<'a>>) {
    for s in symbols {
        keys.push(&s.key);
        out.push(Entry {
            symbol: s,
            keys: keys.clone(),
        });
        flatten(&s.children, keys, out);
        keys.pop();
    }
}

fn segments(s: &str) -> Vec<&str> {
    s.split([':', '.']).filter(|p| !p.is_empty()).collect()
}

fn levenshtein(a: &str, b: &str) -> usize {
    let b: Vec<char> = b.chars().collect();
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.chars().enumerate() {
        let mut cur = vec![i + 1];
        for (j, cb) in b.iter().enumerate() {
            let cost = usize::from(ca != *cb);
            cur.push((prev[j] + cost).min(prev[j + 1] + 1).min(cur[j] + 1));
        }
        prev = cur;
    }
    prev[b.len()]
}

fn suggestions(entries: &[Entry], sep: &str, last: &str) -> Vec<String> {
    let needle = last.to_lowercase();
    let mut out: Vec<String> = Vec::new();
    let mut add = |q: String| {
        if !out.contains(&q) {
            out.push(q);
        }
    };
    if !needle.is_empty() {
        for e in entries {
            if e.own_key().to_lowercase().contains(&needle) {
                add(e.keys.join(sep));
            }
        }
    }
    let mut close: Vec<(usize, String)> = entries
        .iter()
        .filter_map(|e| {
            let d = levenshtein(&e.own_key().to_lowercase(), &needle);
            (d <= MAX_DISTANCE).then(|| (d, e.keys.join(sep)))
        })
        .collect();
    close.sort_by_key(|(d, _)| *d); // stable: ties stay in document order
    for (_, q) in close {
        add(q);
    }
    out.truncate(MAX_SUGGESTIONS);
    out
}

pub fn resolve<'a>(
    symbols: &'a [Symbol],
    lang: Lang,
    query: &str,
    line: Option<usize>,
) -> Resolution<'a> {
    let sep = lang.sep();
    let mut entries = Vec::new();
    flatten(symbols, &mut Vec::new(), &mut entries);
    let wanted = segments(query);

    let mut hits: Vec<&Entry> = entries
        .iter()
        .filter(|e| {
            let path: Vec<&str> = e.keys.iter().flat_map(|k| segments(k)).collect();
            !wanted.is_empty() && path.ends_with(&wanted)
        })
        .collect();

    let name_hits: Vec<&Entry> = hits.clone();
    if let Some(n) = line {
        hits.retain(|e| e.symbol.start_line <= n && n <= e.symbol.end_line);
        if hits.len() > 1 {
            let innermost = hits
                .iter()
                .copied()
                .min_by_key(|e| e.symbol.end_line - e.symbol.start_line);
            hits = innermost.into_iter().collect();
        }
        // The line missed every candidate: show them all rather than "not found".
        if hits.is_empty() {
            hits = name_hits;
        }
    }

    let mut hits: Vec<Hit<'a>> = hits
        .into_iter()
        .map(|e| Hit {
            symbol: e.symbol,
            qualified: e.keys.join(sep),
        })
        .collect();
    match hits.len() {
        0 => Resolution::NotFound(suggestions(
            &entries,
            sep,
            wanted.last().copied().unwrap_or(""),
        )),
        1 => Resolution::Found(hits.remove(0)),
        _ => Resolution::Ambiguous(hits),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::extract::extract;
    use Resolution::*;

    const SERVER: &str = "struct FindServer;\nimpl FindServer {\n    fn find(&self) {}\n    fn run_outline(&self) {}\n}\n";
    const OVERLOADS: &str = "class C\n{\n\n\n    void Add(int a)\n    {\n    }\n\n    void Add(int a, int b)\n    {\n    }\n}\n";
    const PROPS: &str = "class P:\n    @property\n    def x(self):\n        return 1\n\n    @x.setter\n    def x(self, v):\n        pass\n";

    fn found(r: Resolution) -> bool {
        matches!(r, Found(_))
    }

    #[test]
    fn plain_name() {
        let x = extract(SERVER, Lang::Rust);
        let r = resolve(&x.symbols, Lang::Rust, "find", None);
        assert!(matches!(r, Found(h) if h.qualified == "FindServer::find"));
    }

    #[test]
    fn qualified_colons_and_dots() {
        let x = extract(SERVER, Lang::Rust);
        assert!(found(resolve(&x.symbols, Lang::Rust, "FindServer::find", None)));
        assert!(found(resolve(&x.symbols, Lang::Rust, "FindServer.find", None)));
    }

    #[test]
    fn impl_trait_container_is_type() {
        let x = extract(
            "struct Foo;\nimpl std::fmt::Display for Foo {\n    fn fmt(&self) {}\n}\n",
            Lang::Rust,
        );
        assert!(found(resolve(&x.symbols, Lang::Rust, "Foo::fmt", None)));
    }

    #[test]
    fn csharp_dotted_namespace() {
        let x = extract(
            "namespace A.B\n{\n    class C\n    {\n        void M() {}\n    }\n}\n",
            Lang::CSharp,
        );
        assert!(found(resolve(&x.symbols, Lang::CSharp, "B.C.M", None)));
        assert!(found(resolve(&x.symbols, Lang::CSharp, "A.B.C.M", None)));
    }

    #[test]
    fn ambiguous_overloads() {
        let x = extract(OVERLOADS, Lang::CSharp);
        let r = resolve(&x.symbols, Lang::CSharp, "Add", None);
        assert!(matches!(&r, Ambiguous(v)
            if v.len() == 2 && v[0].symbol.start_line < v[1].symbol.start_line));
    }

    #[test]
    fn line_disambiguates() {
        let x = extract(OVERLOADS, Lang::CSharp);
        let r = resolve(&x.symbols, Lang::CSharp, "Add", Some(10));
        assert!(matches!(r, Found(h) if h.symbol.start_line == 9));
    }

    #[test]
    fn line_outside_every_hit_is_ambiguous() {
        let x = extract(OVERLOADS, Lang::CSharp);
        assert!(matches!(
            resolve(&x.symbols, Lang::CSharp, "Add", Some(1)),
            Ambiguous(v) if v.len() == 2
        ));
    }

    #[test]
    fn single_hit_with_stale_line_is_found() {
        let x = extract(SERVER, Lang::Rust);
        let r = resolve(&x.symbols, Lang::Rust, "find", Some(1));
        assert!(matches!(r, Found(h) if h.qualified == "FindServer::find"));
    }

    #[test]
    fn line_with_no_name_match_is_not_found() {
        let x = extract(OVERLOADS, Lang::CSharp);
        assert!(matches!(
            resolve(&x.symbols, Lang::CSharp, "Nope", Some(5)),
            NotFound(_)
        ));
    }

    #[test]
    fn line_picks_innermost() {
        let x = extract(
            "namespace N\n{\n    class N\n    {\n    }\n}\n",
            Lang::CSharp,
        );
        let r = resolve(&x.symbols, Lang::CSharp, "N", Some(4));
        assert!(matches!(r, Found(h) if h.symbol.kind == "class"));
    }

    #[test]
    fn python_property_pair() {
        let x = extract(PROPS, Lang::Python);
        let r = resolve(&x.symbols, Lang::Python, "x", None);
        assert!(matches!(r, Ambiguous(v) if v.len() == 2));
    }

    #[test]
    fn case_sensitive() {
        let x = extract(SERVER, Lang::Rust);
        let r = resolve(&x.symbols, Lang::Rust, "findserver::find", None);
        assert!(matches!(r, NotFound(_)));
    }

    #[test]
    fn suggestions() {
        let x = extract(SERVER, Lang::Rust);
        let r = resolve(&x.symbols, Lang::Rust, "fnd", None);
        assert!(matches!(r, NotFound(s) if s == ["FindServer::find"]));
    }

    #[test]
    fn suggestions_substring_first_then_distance() {
        let x = extract(
            "fn zzfoo() {}\nfn fo() {}\nfn foo_bar() {}\nfn fox() {}\n",
            Lang::Rust,
        );
        let NotFound(s) = resolve(&x.symbols, Lang::Rust, "FOO", None) else {
            panic!("expected NotFound")
        };
        // case-insensitive substring matches in document order, then by distance (ties in document order)
        assert_eq!(s, ["zzfoo", "foo_bar", "fo", "fox"]);
    }

    #[test]
    fn suggestions_capped_at_five() {
        let src: String = "abcdefgh"
            .chars()
            .map(|c| format!("fn get_{c}() {{}}\n"))
            .collect();
        let x = extract(&src, Lang::Rust);
        let NotFound(s) = resolve(&x.symbols, Lang::Rust, "get", None) else {
            panic!("expected NotFound")
        };
        assert_eq!(s.len(), 5);
    }

    #[test]
    fn levenshtein_basics() {
        assert_eq!(levenshtein("kitten", "sitting"), 3);
        assert_eq!(levenshtein("", "abc"), 3);
        assert_eq!(levenshtein("same", "same"), 0);
    }
}
