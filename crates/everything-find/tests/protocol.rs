//! Drives the built binary over stdio MCP and checks the advertised tool.

use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};

const DESCRIPTION: &str = "Use instead of Glob to find files/folders by name, via the Everything index (Windows). Defaults to the current repo, respecting .gitignore and hiding build output, nested repos and worktrees; scope:\"all\" searches every drive. Query uses Everything syntax (wildcards, ext:, dm:today). Not for content search — use Grep.";

const INSTRUCTIONS: &str = "For finding files or folders by name or pattern, prefer `find` over Glob: it respects .gitignore, hides build output, nested repos and worktrees, and returns compact grouped results. Use Grep for content search.";

#[test]
fn tools_list_advertises_find_only() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_everything-find"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn server");
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    let mut send = |v: serde_json::Value| writeln!(stdin, "{v}").unwrap();
    let mut recv = || {
        let mut line = String::new();
        stdout.read_line(&mut line).unwrap();
        serde_json::from_str::<serde_json::Value>(&line).expect(&line)
    };

    send(serde_json::json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{
        "protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}));
    let init = recv();
    assert_eq!(init["result"]["serverInfo"]["name"], "everything-find");
    assert_eq!(init["result"]["instructions"], INSTRUCTIONS);
    send(serde_json::json!({"jsonrpc":"2.0","method":"notifications/initialized"}));
    send(serde_json::json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}));
    let list = recv();
    let _ = child.kill();

    let tools = list["result"]["tools"].as_array().expect("tools array");
    assert_eq!(tools.len(), 1, "{list}");
    assert_eq!(tools[0]["name"], "find");
    assert_eq!(tools[0]["description"], DESCRIPTION);
    let props = tools[0]["inputSchema"]["properties"].as_object().unwrap();
    let mut names: Vec<&str> = props.keys().map(String::as_str).collect();
    names.sort();
    assert_eq!(
        names,
        [
            "count_only", "details", "exclude", "flat", "include_ignored", "kind", "limit", "offset", "path", "query",
            "scope", "sort"
        ]
    );
    assert_eq!(tools[0]["inputSchema"]["required"], serde_json::json!(["query"]));
}
