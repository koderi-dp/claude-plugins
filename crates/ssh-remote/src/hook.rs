//! `ssh-remote session-start`: the SessionStart hook that tells Claude how to call `ssh` and
//! `ssh_download`, and that it must pass credential files by path without reading them.

pub const SESSION_HINT: &str = r#"Remote hosts: to run a command on a machine over SSH, call `ssh` (mcp__plugin_ssh-remote_ssh-remote__ssh) and pass the path of a file holding the password (password_file) or the private key (key_file, plus key_passphrase_file if it is encrypted), e.g. {"host": "10.0.0.21", "user": "root", "password_file": "C:\\temp\\pw.txt", "command": "tail -n 200 /var/log/syslog"}. The plugin reads the file itself and masks the password in tool results; files fetched with `ssh_download` are copied as-is, so never paste a password or other secret from a downloaded file into a reply, a command or another tool call. Never read or print the password file, key file or passphrase file, and never put a password in a command. Follow-up calls to the same user@host reuse the open session, so the credential paths can be left out. To copy a remote file here, call `ssh_download` (mcp__plugin_ssh-remote_ssh-remote__ssh_download) with remote_path; it saves to %TEMP%\ssh-remote\<host>\<file name> unless local_path is given. Prefer these tools over ssh or scp in Bash."#;

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
        assert!(SESSION_HINT.contains("mcp__plugin_ssh-remote_ssh-remote__ssh)"));
        assert!(SESSION_HINT.contains("mcp__plugin_ssh-remote_ssh-remote__ssh_download"));
    }

    #[test]
    fn hint_shows_call_shape() {
        assert!(SESSION_HINT.contains(
            r#"{"host": "10.0.0.21", "user": "root", "password_file": "C:\\temp\\pw.txt", "command": "tail -n 200 /var/log/syslog"}"#
        ));
    }

    #[test]
    fn hint_says_downloads_are_not_masked() {
        assert!(SESSION_HINT.contains("masks the password in tool results"));
        assert!(SESSION_HINT.contains("copied as-is"));
        assert!(!SESSION_HINT.contains("in all output"));
    }

    #[test]
    fn hint_says_never_read_password_file() {
        assert!(SESSION_HINT.contains("Never read or print the password file"));
    }
}
