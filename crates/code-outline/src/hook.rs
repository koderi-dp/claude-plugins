//! `code-outline session-start`: the SessionStart hook that steers Claude
//! towards `outline` and `read_symbol`. Read is always loaded while these tools
//! are deferred, so without a nudge Claude reads whole files.

pub const SESSION_HINT: &str = r#"Code reading: before reading a whole Rust, TS/JS, Python or C# source file, call `outline` (mcp__plugin_code-outline_code-outline__outline) to list its symbols with line ranges, e.g. {"paths": "src/**/*.rs"}. Then read just the symbol you need with `read_symbol` (mcp__plugin_code-outline_code-outline__read_symbol), e.g. {"path": "src/server.rs", "symbol": "FindServer::find"}. Use Read for whole files only when you need most of them."#;

/// Hook stdout for SessionStart.
pub fn session_start_output() -> String {
    serde_json::json!({
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": SESSION_HINT,
        }
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn emits_session_start_context() {
        let v: serde_json::Value = serde_json::from_str(&session_start_output()).unwrap();
        assert_eq!(v["hookSpecificOutput"]["hookEventName"], "SessionStart");
        assert_eq!(v["hookSpecificOutput"]["additionalContext"], SESSION_HINT);
    }

    #[test]
    fn hint_names_both_tools() {
        assert!(SESSION_HINT.contains("mcp__plugin_code-outline_code-outline__outline"));
        assert!(SESSION_HINT.contains("mcp__plugin_code-outline_code-outline__read_symbol"));
    }

    #[test]
    fn hint_shows_call_shapes() {
        assert!(SESSION_HINT.contains(r#"{"paths": "src/**/*.rs"}"#));
        assert!(SESSION_HINT.contains(r#"{"path": "src/server.rs", "symbol": "FindServer::find"}"#));
    }
}
