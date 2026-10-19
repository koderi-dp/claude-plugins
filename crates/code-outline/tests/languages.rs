use code_outline::extract::{Symbol, extract};
use code_outline::lang::Lang;

fn render(syms: &[Symbol], depth: usize, out: &mut Vec<String>) {
    for s in syms {
        out.push(format!("{}{} {}-{}", "  ".repeat(depth), s.label(), s.start_line, s.end_line));
        render(&s.children, depth + 1, out);
    }
}

/// Reads `tests/fixtures/<fixture>`, extracts it, and renders one
/// `label start-end` line per symbol, indented two spaces per nesting level.
fn outline_of(fixture: &str) -> String {
    let path = format!("{}/tests/fixtures/{fixture}", env!("CARGO_MANIFEST_DIR"));
    let source = std::fs::read_to_string(&path).unwrap();
    let lang = Lang::from_path(std::path::Path::new(fixture)).unwrap();
    let mut out = Vec::new();
    render(&extract(&source, lang).symbols, 0, &mut out);
    out.join("\n")
}

#[test]
fn typescript_outline() {
    let expected = [
        "interface ClientOptions 1-4",
        "type Id 6-6",
        "enum Color 8-11",
        "namespace Util 13-15",
        "  function helper 14-14",
        "class ApiClient 17-31",
        "  constructor 18-18",
        "  method get 20-23",
        "  method post 25-26",
        "  method put 28-28",
        "  method put 29-29",
        "  method put 30-30",
        "function createClient 33-33",
        "function outer 35-39",
        "  class Inner 36-38",
        "    method run 37-37",
    ];
    assert_eq!(outline_of("sample.ts"), expected.join("\n"));
}

#[test]
fn tsx_outline() {
    assert_eq!(outline_of("sample.tsx"), "function Button 1-1\nfunction Card 3-3");
}

#[test]
fn javascript_outline() {
    let expected = [
        "function greet 1-3",
        "class Counter 5-10",
        "  constructor 6-6",
        "  method inc 7-8",
        "  method make 9-9",
        "function handler 12-12",
        "function gen 16-16",
    ];
    assert_eq!(outline_of("sample.js"), expected.join("\n"));
}
