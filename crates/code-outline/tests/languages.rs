use code_outline::extract::{Symbol, extract};
use code_outline::lang::Lang;

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
    assert_eq!(
        outline_of("sample.tsx"),
        "function Button 1-1\nfunction Card 3-3"
    );
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

#[test]
fn python_outline() {
    let expected = [
        "class Point 6-11",
        "  def norm 10-11",
        "class Box 14-21",
        "  def x 15-17",
        "  def x 19-21",
        "async def fetch 24-25",
        "def outer 28-31",
        "  def inner 29-30",
        "def route 34-37",
    ];
    assert_eq!(outline_of("sample.py"), expected.join("\n"));
}

fn find<'a>(syms: &'a [Symbol], name: &str) -> &'a Symbol {
    syms.iter().find(|s| s.name == name).unwrap()
}

fn extract_fixture(fixture: &str) -> Vec<Symbol> {
    let path = format!("{}/tests/fixtures/{fixture}", env!("CARGO_MANIFEST_DIR"));
    let source = std::fs::read_to_string(&path).unwrap();
    let lang = Lang::from_path(std::path::Path::new(fixture)).unwrap();
    extract(&source, lang).symbols
}

#[test]
fn python_decorator_in_range() {
    let syms = extract_fixture("sample.py");
    assert_eq!(find(&syms, "Point").start_line, 6); // the @dataclass line
    let route = find(&syms, "route");
    assert_eq!(route.start_line, 34); // the first line of the two-line decorator
    assert_eq!(route.signature, "def route()");
}

#[test]
fn python_decorated_signature_starts_at_def() {
    let syms = extract_fixture("sample.py");
    assert_eq!(find(&syms, "Point").signature, "class Point");
    assert_eq!(
        find(&find(&syms, "Box").children, "x").signature,
        "def x(self)"
    );
    assert_eq!(find(&syms, "fetch").signature, "async def fetch()");
}

#[test]
fn csharp_outline() {
    let expected = [
        "namespace Demo 3-30",
        "  class Store 5-19",
        "    constructor Store 9-9",
        "    method Add 11-11",
        "    method Add 12-12",
        "    property Name 14-14",
        "    class Nested 16-18",
        "  record Person 21-21",
        "  struct Pt 23-23",
        "  interface IThing 25-28",
        "    method Go 27-27",
        "  enum Mode 30-30",
    ];
    assert_eq!(outline_of("sample.cs"), expected.join("\n"));
}

#[test]
fn csharp_signature_skips_attributes() {
    let syms = extract_fixture("sample.cs");
    let cls = find(&find(&syms, "Demo").children, "Store");
    assert_eq!(cls.signature, "public class Store");
}
