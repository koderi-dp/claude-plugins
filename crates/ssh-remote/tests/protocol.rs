//! Drives the built binary over stdio MCP and checks the advertised tools and the argument
//! checks that need no SSH server.

use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

struct Client {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
    init: Value,
}

impl Client {
    fn start() -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_ssh-remote"))
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
            init: Value::Null,
        };
        c.init = c.request(
            "initialize",
            json!({"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"0"}}),
        );
        assert_eq!(
            c.init["result"]["serverInfo"]["name"], "ssh-remote",
            "{}",
            c.init
        );
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
        serde_json::from_str(&line).unwrap_or_else(|e| panic!("{e}: {line:?}"))
    }

    fn call(&mut self, name: &str, arguments: Value) -> Value {
        self.request("tools/call", json!({"name":name,"arguments":arguments}))
    }

    fn tools(&mut self) -> Vec<Value> {
        let list = self.request("tools/list", json!({}));
        list["result"]["tools"]
            .as_array()
            .unwrap_or_else(|| panic!("no tools in {list}"))
            .clone()
    }
}

impl Drop for Client {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

/// The text of a tool error (`isError: true`), panicking on a success or protocol error.
fn tool_error(resp: &Value) -> &str {
    assert_eq!(
        resp["result"]["isError"], true,
        "expected a tool error: {resp}"
    );
    resp["result"]["content"][0]["text"]
        .as_str()
        .unwrap_or_else(|| panic!("no text in {resp}"))
}

fn sorted(v: &Value) -> Vec<String> {
    let mut k: Vec<String> = match v {
        Value::Object(m) => m.keys().cloned().collect(),
        Value::Array(a) => a.iter().map(|x| x.as_str().unwrap().to_string()).collect(),
        _ => panic!("not an object or array: {v}"),
    };
    k.sort();
    k
}

fn ssh_args() -> Value {
    json!({"host": "192.0.2.1", "user": "root", "command": "true"})
}

#[test]
fn lists_two_tools() {
    let mut c = Client::start();
    let tools = c.tools();
    let mut names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
    names.sort();
    assert_eq!(names, ["ssh", "ssh_download"]);

    let ssh = tools.iter().find(|t| t["name"] == "ssh").unwrap();
    assert_eq!(
        ssh["description"],
        "Run a command on a remote host over SSH. Pass credentials as file paths (password_file or key_file); the plugin reads them, so never read or print those files. Calls to the same user@host run one at a time: a call waits for the previous one, and the wait does not count against timeout_s."
    );
    let dl = tools.iter().find(|t| t["name"] == "ssh_download").unwrap();
    let dl_desc = dl["description"].as_str().unwrap();
    assert!(dl_desc.contains("overwrit"), "{dl_desc}");
    assert_eq!(
        sorted(&dl["inputSchema"]["required"]),
        ["host", "remote_path", "user"]
    );
    assert_eq!(
        sorted(&dl["inputSchema"]["properties"]),
        [
            "host",
            "key_file",
            "key_passphrase_file",
            "local_path",
            "password_file",
            "port",
            "remote_path",
            "user"
        ]
    );
}

#[test]
fn no_password_param() {
    let mut c = Client::start();
    for t in c.tools() {
        let props = &t["inputSchema"]["properties"];
        assert!(props.get("password").is_none(), "{}: {props}", t["name"]);
    }
}

#[test]
fn ssh_params_shape() {
    let mut c = Client::start();
    let tools = c.tools();
    let ssh = tools.iter().find(|t| t["name"] == "ssh").unwrap();
    assert_eq!(
        sorted(&ssh["inputSchema"]["required"]),
        ["command", "host", "user"]
    );
    assert_eq!(
        sorted(&ssh["inputSchema"]["properties"]),
        [
            "command",
            "host",
            "key_file",
            "key_passphrase_file",
            "max_lines",
            "password_file",
            "port",
            "timeout_s",
            "user"
        ]
    );
}

#[test]
fn timeout_out_of_range() {
    let mut c = Client::start();
    for t in [0, 601] {
        let mut args = ssh_args();
        args["timeout_s"] = json!(t);
        let resp = c.call("ssh", args);
        assert_eq!(tool_error(&resp), "timeout_s must be 1-600", "{t}");
    }
}

#[test]
fn max_lines_zero() {
    let mut c = Client::start();
    let mut args = ssh_args();
    args["max_lines"] = json!(0);
    let resp = c.call("ssh", args);
    assert_eq!(tool_error(&resp), "max_lines must be at least 1");
}

#[test]
fn passphrase_needs_key_file() {
    let mut c = Client::start();
    let mut args = ssh_args();
    args["key_passphrase_file"] = json!("C:\\nope\\pass.txt");
    let resp = c.call("ssh", args);
    assert_eq!(tool_error(&resp), "key_passphrase_file needs key_file");

    let resp = c.call(
        "ssh_download",
        json!({"host": "192.0.2.1", "user": "root", "remote_path": "/etc/hostname", "key_passphrase_file": "C:\\nope\\pass.txt"}),
    );
    assert_eq!(tool_error(&resp), "key_passphrase_file needs key_file");
}

#[test]
fn missing_credentials_is_a_tool_error() {
    let mut c = Client::start();
    let resp = c.call("ssh", ssh_args());
    assert_eq!(
        tool_error(&resp),
        "no credentials for root@192.0.2.1: pass password_file or key_file"
    );
}

#[test]
fn unreadable_password_file_is_a_tool_error() {
    let d = tempfile::tempdir().unwrap();
    let missing = d.path().join("pw.txt");
    let mut c = Client::start();
    let mut args = ssh_args();
    args["password_file"] = json!(missing.to_str().unwrap());
    let resp = c.call("ssh", args);
    let msg = tool_error(&resp);
    assert!(msg.contains("not found"), "{msg}");
}

#[test]
fn instructions_present() {
    let c = Client::start();
    let instructions = c.init["result"]["instructions"]
        .as_str()
        .unwrap_or_else(|| panic!("no instructions in {}", c.init));
    assert_eq!(instructions, ssh_remote::hook::SESSION_HINT);
    assert!(!instructions.is_empty());
}
