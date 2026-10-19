//! `everything-find session-start`: the SessionStart hook that steers Claude
//! towards `find`. Glob is always loaded while `find` is deferred, so without a
//! nudge Claude reaches for Glob.

use crate::pipeline::Status;

pub const SESSION_HINT: &str = r#"File search: to locate files or folders by name or pattern, call the `find` tool (mcp__plugin_everything-find_everything-find__find) instead of Glob, e.g. {"query": "*.rs"}. It respects .gitignore, hides build output, nested repos and worktrees, and returns compact grouped results. Use Grep for content search."#;

/// Hook stdout for SessionStart, or `None` when Everything is not running
/// (the hint would point at a tool that cannot answer).
pub fn session_start_output(status: Status) -> Option<String> {
    if !status.running {
        return None;
    }
    let out = serde_json::json!({
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": SESSION_HINT,
        }
    });
    Some(out.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn running_emits_session_start_context() {
        let out = session_start_output(Status { running: true, db_loaded: true }).unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["hookSpecificOutput"]["hookEventName"], "SessionStart");
        assert_eq!(v["hookSpecificOutput"]["additionalContext"], SESSION_HINT);
    }

    #[test]
    fn hint_shows_call_shape() {
        assert!(SESSION_HINT.contains(r#"{"query": "*.rs"}"#));
    }

    #[test]
    fn not_running_emits_nothing() {
        assert_eq!(session_start_output(Status { running: false, db_loaded: false }), None);
    }
}
