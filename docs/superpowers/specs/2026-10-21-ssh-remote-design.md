# ssh-remote — Design

Date: 2026-10-21
Status: Draft for review

## Context

Fourth plugin in this marketplace, after everything-find, code-outline and
output-trim. Same conventions: Rust, one Cargo workspace, prebuilt exe committed
into the plugin folder, MCP stdio server built on `rmcp` 3.5.1, Windows only,
published with `just publish ssh-remote <version>`.

## Goal

Let Claude debug remote machines over SSH when the user hands it ad-hoc access:
"user `root`, the password is in `C:\temp\pw.txt`, host `10.0.0.21`, check
`/var/log/syslog`". Today the model will not type or use a plain password, so the
user has to run the commands themselves. The plugin reads the password from the
file itself; Claude only ever handles the file's **path**.

### Success criteria

- Claude can run a command on a host given host, user and a password-file path,
  with no prompt for the password and no password in the conversation.
- The secret never appears in a tool call, tool result, error message, log or
  transcript, even if the remote command echoes it.
- A follow-up command to the same host reuses the open connection (no second
  handshake, no second read of the password file).
- Long log output comes back as a compact head/tail with the full output saved
  to a local file.
- A whole remote file can be downloaded to a local path for Read or Grep.

### Non-goals (v1)

Upload, jump hosts / ProxyJump, interactive shells or PTYs, a hosts config file
with aliases, per-host read-only modes, ssh-agent, Linux/macOS builds.

## Decisions

| Question | Decision | Why |
|---|---|---|
| One plugin or a separate credentials plugin | One plugin; credentials are an internal module | Plugins only talk through Claude, so a separate credentials plugin would pass the secret through Claude's context. |
| SSH implementation | Pure Rust: `russh` + `russh-sftp` | Password and key auth in-process (OpenSSH refuses non-interactive passwords), one self-contained exe, no C/OpenSSL build, keeps connections open. |
| Where credentials live | A file the user names per call (`password_file`, or `key_file` + optional `key_passphrase_file`) | Ad-hoc debugging; no config to maintain. |
| Guardrails | None in the plugin; Claude Code's permission prompt approves each call and shows the full command | Without a config there is nowhere to mark hosts, and classifying commands as read or write from text is guesswork. |
| Host keys | Always auto-trust. New keys are remembered silently; a changed key is accepted, replaces the stored one, and adds a warning line with old and new fingerprints | Debug targets (rebuilt VMs, containers on reused IPs) change keys often. The warning keeps a changed key visible. Accepted risk: a man-in-the-middle would succeed, flagged only by that warning. |

## Tools

### `ssh`

Runs one command and returns its output.

| Param | Type | Default | Notes |
|---|---|---|---|
| `host` | string | required | IP or hostname |
| `user` | string | required | |
| `command` | string | required | Run through the remote user's shell |
| `port` | int | 22 | |
| `password_file` | string | — | Path to a file holding only the password |
| `key_file` | string | — | Path to a private key (OpenSSH or PEM format) |
| `key_passphrase_file` | string | — | Path to a file holding the key's passphrase |
| `timeout_s` | int | 60 | 1–600 |
| `max_lines` | int | 200 | Lines shown before trimming to head and tail |

You need at least one of `password_file` and `key_file` for the first call to a
host. Later calls to the same `user@host:port` while its connection is open may
leave both out. When both are given, the key is tried first, then the password.
There is deliberately **no** `password` parameter.

Result:

```
root@10.0.0.21 · exit 1 · 0.4 s
<stdout, trimmed: first 100 lines, "… 3,412 lines omitted …", last 100 lines>
--- stderr ---
<stderr, trimmed the same way; section left out when empty>
full output: C:\Users\…\Temp\ssh-remote\10.0.0.21\20261021-101502.log
```

If the host key changed, a first line is added:
`warning: host key for 10.0.0.21 changed (SHA256:old… → SHA256:new…), accepted`.
A non-zero exit code is a normal result, not an error. The full-output line is
present only when something was trimmed.

### `ssh_download`

Downloads one remote file over SFTP.

| Param | Type | Default | Notes |
|---|---|---|---|
| `host`, `user`, `port`, `password_file`, `key_file`, `key_passphrase_file` | | | Same as `ssh` |
| `remote_path` | string | required | |
| `local_path` | string | `%TEMP%\ssh-remote\<host>\<file name>` | Parent folder is created |

Result: `downloaded /var/log/syslog → C:\…\syslog (2.4 MB, 0.8 s)`. Refuses
files over 200 MB, stating the size.

## Components (`crates/ssh-remote/src/`)

- **`secret.rs`**: `Secret::from_file(path)`.
  - Reads the file and trims one trailing `\r\n` or `\n`.
  - Refuses an empty file or one over 4 KB, which is probably the wrong file.
  - `Debug` and `Display` print `***`; the memory is zeroed on drop (`zeroize`).
  - `mask(&self, text) -> String` replaces each copy of the secret with `***`.
  - Nothing else in the crate can read the bytes except the auth call.
- **`known_hosts.rs`**: a store in `%LOCALAPPDATA%\ssh-remote\known_hosts`, one
  `host:port SHA256:…` line per host. `check_and_record(host, port, key) ->
  New | Match | Changed { old }` always records the presented key.
- **`pool.rs`**: open sessions keyed by `user@host:port`.
  - A session closes after 5 minutes idle.
  - A dead session is reconnected once, using the credentials that were cached
    as `Secret`s for that key while it was open.
  - The cached secrets are dropped when the session closes.
- **`exec.rs`**: opens a channel, runs the command, and collects stdout, stderr
  and the exit status. On timeout it closes the channel and returns the partial
  output marked `timed out after N s`.
- **`transfer.rs`**: SFTP stat for the size check, then a streamed download to
  the local path.
- **`format.rs`**: header, head/tail trimming, saving the full output, and the
  host-key warning. **Masking runs last** over the whole result string, for
  every secret used on that session.
- **`server.rs` / `main.rs`**: the rmcp server with the two tools and
  `with_instructions(...)`, plus a `session-start` argument for the hook.
- **`hook.rs`**: the SessionStart hint, roughly: "Remote debugging over SSH: call
  `ssh` (mcp__plugin_ssh-remote_ssh-remote__ssh) with host, user and the
  password_file path, e.g. {...}. Never read or print the password file
  yourself; pass its path."

### Plugin folder `plugins/ssh-remote/`

`.claude-plugin/plugin.json` (0.1.0), `.mcp.json`, `hooks/hooks.json`
(SessionStart → `ssh-remote.exe session-start`), and `bin/ssh-remote.exe`. A
marketplace entry goes into `.claude-plugin/marketplace.json`.

## Data flow

1. Claude calls `ssh` with paths only.
2. The server looks up the pool. On a miss it reads the secrets from the files,
   connects, checks and records the host key, authenticates and stores the
   session.
3. It runs the command, formats the result, masks it and returns it.
4. Secrets never leave `secret.rs` except into the russh auth call.

## Errors

Each error is one line, names the file and never its contents.

- `auth failed for root@10.0.0.21:22 (tried key C:\…\id_ed25519, password from C:\temp\pw.txt)`
- `cannot reach 10.0.0.21:22: connection timed out after 10 s`
- `password file C:\temp\pw.txt: not found` / `is empty` / `is 18 KB; expected a file holding only the password`
- `no credentials for root@10.0.0.21: pass password_file or key_file`
- `key C:\…\id_rsa is encrypted: pass key_passphrase_file`
- `remote file /var/log/big.log is 1.3 GB; limit is 200 MB`

The connect timeout is 10 s, separate from the command's `timeout_s`.

## Testing

- **Unit tests:**
  - `Secret`: trimming, the size and empty refusals, `Debug` showing `***`, and
    `mask` handling repeated and overlapping copies.
  - `known_hosts`: new, match, changed and recorded.
  - `format`: trimming boundaries, stderr left out when empty, warning
    placement, and masking applied after trimming.
- **Protocol test (`tests/protocol.rs`):**
  - the tool list and params;
  - no param named `password`;
  - instructions are present.
- **Live tests (`tests/live.rs`, `#[ignore]`, `just test-live`):**
  - Run against an OpenSSH server in a local Docker container
    (`linuxserver/openssh-server` or similar), with a password user and a key
    user. It is started by a `just` recipe.
  - Cover: password auth, key auth, encrypted key, wrong password, connection
    reuse (second call faster and the password file not read again), timeout
    with partial output, download, and the size cap.
  - Changed host key: recreate the container, expect the warning, and expect
    the call to succeed.
  - A command that echoes the password returns `***`.

## Risks

- `russh` may not support some older servers' algorithms (e.g. `ssh-rsa` with
  SHA-1 only). Mitigation: enable russh's legacy algorithm set; the error names
  the negotiation failure.
- Auto-trusting changed keys accepts a man-in-the-middle. Accepted for
  debugging use; the warning keeps it visible.
- The password file path is visible to Claude, and Claude could still Read it.
  Mitigation: the SessionStart hint and tool description say not to. Claude
  Code's own rules also keep it from typing passwords.
