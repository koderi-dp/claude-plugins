# ssh-remote Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An MCP plugin that runs commands on, and downloads files from, remote hosts over SSH, using credentials Claude gives it only as file paths.

**Architecture:** The new crate `crates/ssh-remote` uses `russh` and `russh-sftp`:
- a `Secret` type that is the only holder of credential bytes;
- a pool of open sessions keyed by `user@host:port`;
- a formatter that trims output and masks secrets as its last step;
- an rmcp stdio server exposing `ssh` and `ssh_download`.

It is packaged like the other plugins: a prebuilt exe in `plugins/ssh-remote/bin`, plus a SessionStart hint.

**Tech Stack:**
- Rust 2024 edition; `rmcp` 3.5.1 and `tokio`.
- `russh` 0.64.1 with `default-features = false, features = ["ring", "rsa", "flate2"]`. That is ring, not aws-lc-rs, so there is no cmake/nasm build on Windows.
- `russh-sftp` 3.0.1, `zeroize` 1.9, `chrono`, `serde`, `schemars`, `anyhow`, `dunce`.
- Dev: `tempfile`, `serde_json`.

**Spec:** `docs/superpowers/specs/2026-10-21-ssh-remote-design.md`

## Global Constraints

- **Secrets:** no tool parameter is named `password`. A secret never appears in a tool result, error string, log or `Debug` output.
- **Secret files:** trim one trailing `\r\n` or `\n`; refuse an empty file or one over 4 KB.
- **Host keys:** always accepted. A new key is recorded silently. A changed key is accepted and replaces the old one, and the result begins with this line:
  `warning: host key for <host> changed (<old> → <new>), accepted`
  where the fingerprints are `SHA256:…`.
- **Known-hosts file:** `%LOCALAPPDATA%\ssh-remote\known_hosts`, one `host:port SHA256:…` line per host.
- **Timeouts and limits:**
  - connect timeout 10 s;
  - `timeout_s` defaults to 60, range 1–600;
  - `max_lines` defaults to 200, shown as head = max_lines/2 and tail = max_lines/2;
  - idle sessions close after 5 min;
  - a dead session reconnects once;
  - download cap is 200 MB.
- **Full output:** saved to `%TEMP%\ssh-remote\<host>\<YYYYMMDD-HHMMSS>.log`, only when the output was trimmed.
- **Downloads:** the default destination is `%TEMP%\ssh-remote\<host>\<remote file name>`.
- **Exit codes:** a non-zero exit is a normal result. The header is `<user>@<host> · exit <n> · <secs> s`.
- **Credential order:** the key is tried before the password. When credentials are missing and no session is open, the error is:
  `no credentials for <user>@<host>: pass password_file or key_file`
- **Windows-only crate,** matching the existing plugins. Exes are release-built with the workspace's `[profile.release]`.

## Review Focus

1. **Password file saved with a UTF-8 BOM or as UTF-16 by Notepad:** the BOM must be stripped, and UTF-16 should be decoded or refused with a clear message. A wrong secret here gives a confusing "auth failed". The test goes in Task 1.
2. **Remote output containing the secret split across a stdout/stderr boundary, or appearing in the trimmed-away middle:** masking runs on the final string *and* on the saved full-output file. The test goes in Task 3.
3. **Non-UTF-8 output (binary log, Latin-1):** lossy decoding, never a panic. The test goes in Task 3.
4. **Same host, different user, in one session:** separate pool entries, and neither one's secret is used for the other. The test goes in Task 5.
5. **Command still producing output after the timeout fires** (`tail -f`): the call returns at the timeout with partial output and closes the channel, and the next call on that session works. The live test goes in Task 4.

---

## File Structure

```
crates/ssh-remote/
  Cargo.toml
  src/
    lib.rs          module list
    secret.rs       Secret: read from file, mask, zeroize
    known_hosts.rs  KnownHosts store: New / Match / Changed
    format.rs       render results: header, trim, warning, full-output file, masking
    session.rs      connect + host-key handler + auth + exec on one russh session
    pool.rs         sessions keyed by user@host:port, idle expiry, reconnect once
    transfer.rs     SFTP download with size cap
    params.rs       SshParams / DownloadParams (serde + schemars)
    hook.rs         SessionStart hint
    server.rs       rmcp tools ssh, ssh_download
    main.rs         session-start arg | server
  tests/
    protocol.rs     tool list, params, instructions
    live.rs         #[ignore] against the Docker test server
plugins/ssh-remote/
  .claude-plugin/plugin.json, .mcp.json, hooks/hooks.json, bin/ssh-remote.exe
justfile            + ssh-test-server / ssh-test-server-reset recipes
.claude-plugin/marketplace.json  + ssh-remote entry
```

---

### Task 1: Crate scaffold and `Secret`

**Files:**
- Create: `crates/ssh-remote/Cargo.toml`, `src/lib.rs`, `src/secret.rs`

**Interfaces:**
- Produces:
  - `pub struct Secret` (no `Clone`, so it is never copied by accident).
  - `Secret::from_file(path: &Path) -> Result<Secret, String>`; the error strings name the path.
  - `Secret::expose(&self) -> &str`, used only by `session.rs` for auth.
  - `Secret::mask(&self, text: &str) -> String`.
  - `pub fn mask_all(secrets: &[&Secret], text: &str) -> String`.
  - `impl Debug` and `impl Display` print `***`; `Drop` zeroizes.

- [ ] **Step 1: Write the failing tests in `secret.rs`**
  - `trims_one_trailing_newline`: the file holds `"pw\r\n"`, so `expose() == "pw"`; the file holds `"pw\n\n"`, so `expose() == "pw\n"`.
  - `strips_utf8_bom`: bytes `EF BB BF` then `pw`, so `expose() == "pw"`.
  - `decodes_utf16le_with_bom`: bytes `FF FE` + UTF-16LE `"pw\r\n"`, so `expose() == "pw"`.
  - `refuses_empty`: the error contains the path and `is empty`.
  - `refuses_over_4kb`: a 5000-byte file gives an error containing `expected a file holding only the password`.
  - `missing_file`: the error contains `not found`.
  - `debug_hides`: `format!("{:?}", s) == "***"` and `format!("{}", s) == "***"`.
  - `masks_every_copy`: `mask("a pw b pwpw")` gives `"a *** b ******"`.
  - `mask_all_longest_first`: secrets `pw` and `pw123`, text `"pw123 pw"` gives `"*** ***"`.

- [ ] **Step 2: Run them to check they fail**
  Run: `cargo test -p ssh-remote secret 2>&1 | output-trim`
  Expected: compile failure, then failures.

- [ ] **Step 3: Implement `secret.rs`**
  Detect a BOM in this order: UTF-8, then UTF-16LE, then UTF-16BE. Otherwise decode as UTF-8, or fail with `is not UTF-8 or UTF-16 text`. Store the result in `zeroize::Zeroizing<String>`. `mask_all` sorts the secrets by length, longest first.

- [ ] **Step 4: Run the tests and check they pass**
  Run: `cargo test -p ssh-remote secret 2>&1 | output-trim`
  Expected: PASS.

- [ ] **Step 5: Commit** with `feat(ssh-remote): crate scaffold and Secret`

### Task 2: `KnownHosts`

**Files:**
- Create: `src/known_hosts.rs`

**Interfaces:**
- Produces:
  - `pub enum HostKeyStatus { New, Match, Changed { old: String } }`
  - `pub struct KnownHosts { path: PathBuf }`
  - `KnownHosts::default_path() -> PathBuf`, which is `%LOCALAPPDATA%\ssh-remote\known_hosts`.
  - `KnownHosts::new(path: PathBuf) -> KnownHosts`
  - `KnownHosts::check_and_record(&self, host: &str, port: u16, fingerprint: &str) -> std::io::Result<HostKeyStatus>`. It always writes the presented fingerprint, creating the parent folder if needed. The fingerprint is the `SHA256:…` string that Task 4 produces with `russh::keys::PublicKey::fingerprint(HashAlg::Sha256)`.

- [ ] **Step 1: Write the failing tests**
  - `first_seen_is_new_then_match`
  - `changed_returns_old_and_replaces`: record `A`, then present `B`, giving `Changed { old: "A" }`; presenting `B` again gives `Match`.
  - `ports_are_separate`: `h:22` and `h:2222` are independent.
  - `keeps_other_hosts`: replacing one line leaves the others intact.
  - `creates_parent_dir`

- [ ] **Step 2: Run them to check they fail.** Run: `cargo test -p ssh-remote known_hosts`

- [ ] **Step 3: Implement** with a line-based read-modify-write of the whole file. The files are tiny, so no locking is needed beyond a process-wide `Mutex` held by the caller.

- [ ] **Step 4: Run them to check they pass.**

- [ ] **Step 5: Commit** with `feat(ssh-remote): known_hosts store with auto-trust`

### Task 3: Result formatting

**Files:**
- Create: `src/format.rs`

**Interfaces:**
- Consumes: `secret::mask_all`, `known_hosts::HostKeyStatus`.
- Produces:
  - `pub struct ExecOutcome { pub user: String, pub host: String, pub exit: Option<u32>, pub elapsed: Duration, pub stdout: Vec<u8>, pub stderr: Vec<u8>, pub timed_out: Option<u64>, pub key_status: HostKeyStatus }`
  - `pub fn render_exec(o: &ExecOutcome, max_lines: usize, secrets: &[&Secret], full_dir: &Path) -> String`
  - `pub fn render_download(remote: &str, local: &Path, bytes: u64, elapsed: Duration, key_status: &HostKeyStatus) -> String`

- [ ] **Step 1: Write the failing tests**
  - `header_shape`: the result starts with `root@10.0.0.21 · exit 0 · 0.4 s`.
  - `no_trim_under_limit`: 10 lines with `max_lines` 200 shows all of them, with no `full output:` line and no file written in `full_dir`.
  - `trims_head_and_tail`: 1000 lines numbered `1..=1000` with `max_lines` 200 shows lines `1`–`100`, then `… 800 lines omitted …`, then `901`–`1000`. A `full output: <path>` line is present and the file holds all 1000 lines.
  - `stderr_section_only_when_nonempty`
  - `timeout_marker`: `timed_out: Some(60)` puts `timed out after 60 s` in the header line instead of `exit n`.
  - `changed_key_warning_first_line`: the output starts with `warning: host key for 10.0.0.21 changed (SHA256:old → SHA256:new), accepted`.
  - `masks_after_trim_and_in_file`: the secret appears in line 500 (the omitted part) and in line 1. The returned text has no secret and the saved full-output file has no secret either.
  - `secret_across_stdout_stderr_is_masked_in_each`
  - `lossy_utf8`: stdout `[0xff, b'o', b'k']` renders without panicking and contains `ok`.
  - `download_line`: the result is `downloaded /var/log/syslog → C:\x\syslog (2.4 MB, 0.8 s)`.

- [ ] **Step 2: Run them to check they fail.**

- [ ] **Step 3: Implement**
  - Use `String::from_utf8_lossy`.
  - Size units are B, KB and MB with one decimal; elapsed time is shown in seconds with one decimal.
  - The full-output file name is `chrono::Local::now().format("%Y%m%d-%H%M%S")` with a `.log` extension.
  - Mask the stdout and stderr text before writing the file and before trimming.

- [ ] **Step 4: Run them to check they pass.**

- [ ] **Step 5: Commit** with `feat(ssh-remote): result formatting with trimming and masking`

### Task 4: SSH session (connect, host key, auth, exec) and the Docker test server

**Files:**
- Create: `src/session.rs`, `tests/live.rs`
- Modify: `justfile`, adding the recipes below.

**Interfaces:**
- Consumes: `Secret`, `KnownHosts`, `HostKeyStatus`, `ExecOutcome`.
- Produces:
  - `pub struct Creds { pub password: Option<Secret>, pub key: Option<(PathBuf, Option<Secret>)> }`. The key is a path plus an optional passphrase.
  - `pub struct Target { pub host: String, pub port: u16, pub user: String }`
  - `pub struct Session` wraps `russh::client::Handle<Handler>`, plus `key_status: HostKeyStatus` from connect time.
  - `Session::connect(t: &Target, creds: &Creds, known: &KnownHosts) -> Result<Session, String>`
  - `Session::exec(&self, command: &str, timeout: Duration) -> Result<ExecOutcome, String>`
  - `Session::is_closed(&self) -> bool`
  - `Session::sftp(&self) -> Result<russh_sftp::client::SftpSession, String>`, used in Task 6.
- Live-test environment, read by `tests/live.rs`:
  - `SSH_TEST_HOST`, default `127.0.0.1`, and `SSH_TEST_PORT`, default `2222`;
  - user `tester`;
  - password file `target/ssh-test/pw.txt`;
  - key `target/ssh-test/id_ed25519`, and encrypted key `target/ssh-test/id_enc` with passphrase file `target/ssh-test/id_enc.pass`.

- [ ] **Step 1: Add the `just` recipes**
  - `ssh-test-server` runs these steps:
    1. Generate the keys with `ssh-keygen` (Windows OpenSSH) into `target/ssh-test/`.
    2. Write `pw.txt`.
    3. Run `docker run -d --name ssh-remote-test -p 2222:2222 -e USER_NAME=tester -e PASSWORD_ACCESS=true -e USER_PASSWORD_FILE=/pw -v <abs>/target/ssh-test/pw.txt:/pw:ro -e PUBLIC_KEY_DIR=/keys -v <abs>/target/ssh-test/pub:/keys:ro lscr.io/linuxserver/openssh-server:latest`.
    4. Wait until port 2222 accepts connections.
  - `ssh-test-server-reset` removes and recreates the container. This gives new host keys, for the changed-key test.
  - `test-live` also runs `cargo test -p ssh-remote --test live -- --ignored --test-threads=1`.

- [ ] **Step 2: Write the failing live tests (`#[ignore]`)**
  - `password_auth_runs_command`: `echo hi` gives exit 0 and stdout `hi\n`.
  - `key_auth_runs_command`
  - `encrypted_key_needs_passphrase`: without the passphrase the error contains `is encrypted: pass key_passphrase_file`; with it, the command succeeds.
  - `wrong_password_message`: the error is `auth failed for tester@127.0.0.1:2222 (password from <path>)` and contains no secret.
  - `nonzero_exit_is_ok`: `exit 3` gives `exit == Some(3)`.
  - `timeout_returns_partial`: `echo start; sleep 30` with a 2 s timeout gives `timed_out == Some(2)`, stdout contains `start`, and the call returns in under 5 s.
  - `session_usable_after_timeout`: after the previous test, `echo ok` on the same `Session` succeeds.
  - `unreachable_host`: port 2299 gives `cannot reach 127.0.0.1:2299` within 11 s.
  - `known_host_recorded_then_changed`: connect gives `New`, connect again gives `Match`. Then run `just ssh-test-server-reset` through `std::process::Command`, and connect gives `Changed`.

- [ ] **Step 3: Run them to check they fail.** Run `just ssh-test-server`, then `cargo test -p ssh-remote --test live -- --ignored --test-threads=1`.

- [ ] **Step 4: Implement `session.rs`**
  - **Host-key handler:** `russh::client::Handler::check_server_key` computes the fingerprint, calls `KnownHosts::check_and_record`, stores the status in the handler and returns `Ok(true)`.
  - **Config:** enable the `ssh-rsa` legacy algorithm in `russh::client::Config::preferred`, alongside the defaults.
  - **Connect:** `tokio::time::timeout(10 s, russh::client::connect(...))`.
  - **Auth:** key first, via `russh::keys::load_secret_key(path, passphrase)` and `authenticate_publickey`, then `authenticate_password`.
  - **Exec:** `channel_open_session` then `exec`, reading `ChannelMsg::Data`, `ExtendedData { ext: 1 }` and `ExitStatus` until `Eof`/`Close` or the timeout. On timeout, close the channel.

- [ ] **Step 5: Run them to check they pass** with the same command as Step 3.

- [ ] **Step 6: Commit** with `feat(ssh-remote): russh session with auto-trust, auth and exec`

### Task 5: Session pool

**Files:**
- Create: `src/pool.rs`

**Interfaces:**
- Consumes: `Session`, `Creds`, `Target`, `KnownHosts`.
- Produces:
  - `pub struct Pool`, an internal `tokio::sync::Mutex<HashMap<String, Entry>>` where `Entry { session: Session, creds: Creds, last_used: Instant }`.
  - `Pool::new(known: KnownHosts, idle: Duration) -> Pool`
  - `Pool::with_session<T>(&self, t: &Target, creds: Option<Creds>, f: impl AsyncFnOnce(&Session, &[&Secret]) -> Result<T, String>) -> Result<T, String>`. `f` receives the session and every `Secret` held for that entry (password and passphrase), so the caller can format and mask inside `f`. Secrets are never copied out of the pool. The host-key status is available as `session.key_status`.
  - `pub fn key(t: &Target) -> String`, giving `user@host:port`.
  - Behaviour:
    - The caller's `creds`, when present, replace the stored ones.
    - With no `creds` and no entry, the error is `no credentials for …`.
    - A closed session is reconnected once using the stored `creds`.
    - Entries idle longer than `idle` are dropped when the pool is next accessed. Dropping the entry also drops its secrets.

- [ ] **Step 1: Write the failing tests**
  - Unit, no network: `key_format`.
  - Unit, no network: `missing_creds_error`, giving exactly `no credentials for root@10.0.0.21: pass password_file or key_file`.
  - Live: `reuses_session_without_password_file`. The second call passes `creds: None` and the password file has been deleted in between, yet the call succeeds.
  - Live: `different_users_are_separate_entries`. `tester` and a second container user `other` with a different password both work, and a call as `other` with no creds fails with `no credentials`.
  - Live: `idle_expiry`. With `idle` = 1 s, after a 2 s sleep a call with no creds fails with `no credentials`.

- [ ] **Step 2: Run them to check they fail.** The second test needs `USER_NAME=other` in a second container on port 2223; add it to the `ssh-test-server` recipe.

- [ ] **Step 3: Implement `pool.rs`.**

- [ ] **Step 4: Run them to check they pass.**

- [ ] **Step 5: Commit** with `feat(ssh-remote): session pool with reuse, idle expiry and reconnect`

### Task 6: SFTP download

**Files:**
- Create: `src/transfer.rs`

**Interfaces:**
- Consumes: `Session::sftp`.
- Produces:
  - `pub async fn download(s: &Session, remote: &str, local: &Path, cap: u64) -> Result<u64, String>`, returning the bytes written.
  - `pub fn default_local_path(host: &str, remote: &str) -> PathBuf`
  - Cap error: `remote file <remote> is <size>; limit is 200 MB`.

- [ ] **Step 1: Write the failing tests**
  - Unit: `default_path_shape`. Host `10.0.0.21` and remote `/var/log/syslog` give a path ending in `ssh-remote\10.0.0.21\syslog`.
  - Live: `downloads_file`. Create `/tmp/f.txt` with `ssh`, download it, and check the bytes are equal.
  - Live: `creates_parent_dirs`
  - Live: `refuses_over_cap`. With `cap` = 10 and an 11-byte file, the error contains `limit is`.
  - Live: `missing_remote_file`. The error contains the remote path.

- [ ] **Step 2: Run them to check they fail.**

- [ ] **Step 3: Implement.** `stat` the file for its size first, then stream with `tokio::io::copy` into `tokio::fs::File`.

- [ ] **Step 4: Run them to check they pass.**

- [ ] **Step 5: Commit** with `feat(ssh-remote): SFTP download with size cap`

### Task 7: MCP server, hint, packaging and release

**Files:**
- Create: `src/params.rs`, `src/hook.rs`, `src/server.rs`, `src/main.rs`, `tests/protocol.rs`
- Create: `plugins/ssh-remote/.claude-plugin/plugin.json` (version `0.1.0`), `.mcp.json`, `hooks/hooks.json`
- Modify: `.claude-plugin/marketplace.json`

**Interfaces:**
- Consumes: `Pool`, `transfer::download`, `format::render_exec` and `render_download`, `Secret::from_file`.
- Produces:
  - `SshParams { host, user, command, port: Option<u16>, password_file, key_file, key_passphrase_file, timeout_s: Option<u64>, max_lines: Option<usize> }`
  - `DownloadParams { host, user, port, password_file, key_file, key_passphrase_file, remote_path, local_path: Option<String> }`
  - The tool names are `ssh` and `ssh_download`.
  - `hook::SESSION_HINT` and `hook::session_start_output() -> String`, the same JSON shape as code-outline's.

- [ ] **Step 1: Write the failing tests**
  - `protocol.rs::lists_two_tools`
  - `protocol.rs::no_password_param`: no tool's input schema has a property named `password`.
  - `protocol.rs::ssh_params_shape`: the required fields are exactly `host`, `user` and `command`.
  - `protocol.rs::timeout_out_of_range`: `timeout_s: 0` and `timeout_s: 601` give the tool error `timeout_s must be 1-600`.
  - `protocol.rs::instructions_present`
  - `hook.rs::emits_session_start_context`
  - `hook.rs::hint_shows_call_shape`: the hint contains `{"host": "10.0.0.21", "user": "root", "password_file": "C:\\temp\\pw.txt", "command": "tail -n 200 /var/log/syslog"}`.
  - `hook.rs::hint_says_never_read_password_file`: contains `Never read or print the password file`.

- [ ] **Step 2: Run them to check they fail.**

- [ ] **Step 3: Implement**
  - **Server:** `params.rs`, `hook.rs`, then `server.rs` using `tool_router`/`tool`/`tool_handler`, following the code-outline server. The server holds one `Pool` with `idle` = 5 min.
  - **Tool description:** "Run a command on a remote host over SSH. Pass credentials as file paths (password_file or key_file); the plugin reads them, so never read or print those files."
  - **Instructions:** the hint text.
  - **`main.rs`:** handles the `session-start` argument the same way as code-outline.

- [ ] **Step 4: Package**
  - Copy `plugins/code-outline/.mcp.json` and `hooks/hooks.json` and replace the exe name.
  - Add the marketplace entry, with description "Run commands and download files over SSH, with credentials read from files Claude never sees."

- [ ] **Step 5: Run all tests and check they pass**
  Run `just test`, expecting PASS. Then run `just ssh-test-server` and `just test-live`, expecting PASS.

- [ ] **Step 6: Manual check through MCP stdio**
  Run the release exe and call `ssh` against the test container with `command: "cat /pw"`, which echoes the password. The result shows `***`.

- [ ] **Step 7: Commit, then publish**
  Commit with `feat(ssh-remote): MCP server, hint and plugin packaging`. Then:
  ```bash
  just publish ssh-remote 0.1.0
  ```
  ```bash
  claude plugin install ssh-remote@code101-plugins
  ```
