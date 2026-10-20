//! Drives the built binary over stdio MCP and checks the advertised tools and calls.

use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

const OUTLINE_DESCRIPTION: &str = "List the symbols (functions, classes, methods…) in source files with line ranges, without reading the bodies. Rust, TS/JS, Python, C#. Use before Read to find what you need, then read_symbol.";
const READ_SYMBOL_DESCRIPTION: &str = "Read one symbol's source (with its doc comments and attributes) from a file, line-numbered like Read. symbol is a name or qualified path: ApiClient.get, FindServer::find.";

struct Client {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
}

impl Client {
    fn start() -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_code-outline"))
            .env("CLAUDE_PROJECT_DIR", env!("CARGO_MANIFEST_DIR"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn server");
        let stdin = child.stdin.take().unwrap();
        let stdout = BufReader::new(child.stdout.take().unwrap());
        let mut c = Client {
            child,
            stdin,
            stdout,
            next_id: 1,
        };
        let init = c.request(
            "initialize",
            json!({"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"0"}}),
        );
        assert_eq!(init["result"]["serverInfo"]["name"], "code-outline");
        writeln!(
            c.stdin,
            "{}",
            json!({"jsonrpc":"2.0","method":"notifications/initialized"})
        )
        .unwrap();
        c
    }

    fn request(&mut self, method: &str, params: Value) -> Value {
        let id = self.next_id;
        self.next_id += 1;
        writeln!(
            self.stdin,
            "{}",
            json!({"jsonrpc":"2.0","id":id,"method":method,"params":params})
        )
        .unwrap();
        let mut line = String::new();
        self.stdout.read_line(&mut line).unwrap();
        serde_json::from_str(&line).expect(&line)
    }

    fn call(&mut self, name: &str, arguments: Value) -> Value {
        self.request("tools/call", json!({"name":name,"arguments":arguments}))
    }
}

impl Drop for Client {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

fn text_of(resp: &Value) -> &str {
    resp["result"]["content"][0]["text"]
        .as_str()
        .unwrap_or_else(|| panic!("no text in {resp}"))
}

fn sorted_keys(v: &Value) -> Vec<&str> {
    let mut k: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
    k.sort();
    k
}

#[test]
fn tools_list_advertises_outline_and_read_symbol() {
    let mut c = Client::start();
    let list = c.request("tools/list", json!({}));
    let tools = list["result"]["tools"].as_array().expect("tools array");
    let mut names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
    names.sort();
    assert_eq!(names, ["outline", "read_symbol"]);

    let tool = |n: &str| tools.iter().find(|t| t["name"] == n).unwrap();
    let outline = tool("outline");
    assert_eq!(outline["description"], OUTLINE_DESCRIPTION);
    assert_eq!(outline["inputSchema"]["required"], json!(["paths"]));
    assert_eq!(
        sorted_keys(&outline["inputSchema"]["properties"]),
        ["limit", "paths", "signatures"]
    );

    let read = tool("read_symbol");
    assert_eq!(read["description"], READ_SYMBOL_DESCRIPTION);
    assert_eq!(read["inputSchema"]["required"], json!(["path", "symbol"]));
    assert_eq!(
        sorted_keys(&read["inputSchema"]["properties"]),
        ["line", "path", "symbol"]
    );
}

#[test]
fn outline_call_returns_file_outline() {
    let mut c = Client::start();
    let resp = c.call("outline", json!({"paths": "tests/fixtures/sample.rs"}));
    assert!(
        text_of(&resp).starts_with("tests/fixtures/sample.rs ("),
        "{resp}"
    );
}

#[test]
fn read_symbol_call_returns_numbered_lines() {
    let mut c = Client::start();
    let resp = c.call(
        "read_symbol",
        json!({"path": "tests/fixtures/sample.rs", "symbol": "Greeter::greet"}),
    );
    let second = text_of(&resp)
        .lines()
        .nth(1)
        .unwrap_or_else(|| panic!("too short: {resp}"));
    let (num, _) = second
        .split_once('\t')
        .unwrap_or_else(|| panic!("no tab: {second:?}"));
    assert_eq!(num.len(), 6, "{second:?}");
    assert!(num.trim().parse::<u32>().is_ok(), "{second:?}");
}

#[test]
fn invalid_limit_is_an_invalid_params_error() {
    let mut c = Client::start();
    let resp = c.call("outline", json!({"paths": "x", "limit": 0}));
    let msg = resp["error"]["message"]
        .as_str()
        .unwrap_or_else(|| panic!("expected error: {resp}"));
    assert!(msg.contains("limit"), "{msg}");
}
