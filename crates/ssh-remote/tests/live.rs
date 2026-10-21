//! Live tests against the OpenSSH test container. Start it with `just ssh-test-server`, then run
//! `cargo test -p ssh-remote --test live -- --ignored --test-threads=1`.
//!
//! Every test uses its own known_hosts file in a tempdir, so the order does not matter, even for
//! the test that recreates the container (new host keys, same credentials).

use std::path::PathBuf;
use std::time::{Duration, Instant};

use ssh_remote::known_hosts::{HostKeyStatus, KnownHosts};
use ssh_remote::pool::Pool;
use ssh_remote::secret::{Secret, mask_all};
use ssh_remote::session::{Creds, Session, Target};

fn test_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/ssh-test")
}

fn host() -> String {
    std::env::var("SSH_TEST_HOST").unwrap_or_else(|_| "127.0.0.1".into())
}

fn port() -> u16 {
    std::env::var("SSH_TEST_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(2222)
}

fn target() -> Target {
    Target {
        host: host(),
        port: port(),
        user: "tester".into(),
    }
}

fn known() -> (tempfile::TempDir, KnownHosts) {
    let dir = tempfile::tempdir().unwrap();
    let known = KnownHosts::new(dir.path().join("known_hosts"));
    (dir, known)
}

fn password_creds() -> Creds {
    Creds {
        password: Some(Secret::from_file(&test_dir().join("pw.txt")).unwrap()),
        key: None,
    }
}

fn key_creds() -> Creds {
    Creds {
        password: None,
        key: Some((test_dir().join("id_ed25519"), None)),
    }
}

async fn connect(creds: &Creds) -> Session {
    let (_dir, known) = known();
    Session::connect(&target(), creds, &known).await.unwrap()
}

#[tokio::test]
#[ignore]
async fn password_auth_runs_command() {
    let s = connect(&password_creds()).await;
    let out = s.exec("echo hi", Duration::from_secs(10)).await.unwrap();
    assert_eq!(out.exit, Some(0));
    assert_eq!(out.stdout, b"hi\n");
    assert_eq!(out.user, "tester");
    assert_eq!(out.host, host());
    assert_eq!(out.key_status, HostKeyStatus::New);
}

#[tokio::test]
#[ignore]
async fn key_auth_runs_command() {
    let s = connect(&key_creds()).await;
    let out = s
        .exec("echo hi; echo err >&2", Duration::from_secs(10))
        .await
        .unwrap();
    assert_eq!(out.exit, Some(0));
    assert_eq!(out.stdout, b"hi\n");
    assert_eq!(out.stderr, b"err\n");
}

#[tokio::test]
#[ignore]
async fn encrypted_key_needs_passphrase() {
    let key = test_dir().join("id_enc");
    let (_dir, known) = known();
    let without = Creds {
        password: None,
        key: Some((key.clone(), None)),
    };
    let err = Session::connect(&target(), &without, &known)
        .await
        .err()
        .expect("must fail");
    assert!(
        err.contains("is encrypted: pass key_passphrase_file"),
        "{err}"
    );
    assert!(err.contains(&key.display().to_string()), "{err}");

    let pass = Secret::from_file(&test_dir().join("id_enc.pass")).unwrap();
    let with = Creds {
        password: None,
        key: Some((key, Some(pass))),
    };
    let s = Session::connect(&target(), &with, &known).await.unwrap();
    let out = s.exec("echo hi", Duration::from_secs(10)).await.unwrap();
    assert_eq!(out.exit, Some(0));
    assert_eq!(out.stdout, b"hi\n");
}

#[tokio::test]
#[ignore]
async fn unusable_key_falls_back_to_password() {
    let (_ok_dir, ok_known) = known();
    let creds = Creds {
        password: Some(Secret::from_file(&test_dir().join("pw.txt")).unwrap()),
        key: Some((test_dir().join("id_enc"), None)),
    };
    let s = Session::connect(&target(), &creds, &ok_known)
        .await
        .unwrap();
    let out = s.exec("echo hi", Duration::from_secs(10)).await.unwrap();
    assert_eq!(out.exit, Some(0));
    assert_eq!(out.stdout, b"hi\n");

    // Unusable key and a rejected password: the error names both files.
    let (dir, known) = known();
    let pw_path = dir.path().join("wrong.txt");
    std::fs::write(&pw_path, "definitely-not-the-password-7f3a").unwrap();
    let key = test_dir().join("id_enc");
    let creds = Creds {
        password: Some(Secret::from_file(&pw_path).unwrap()),
        key: Some((key.clone(), None)),
    };
    let err = Session::connect(&target(), &creds, &known)
        .await
        .err()
        .expect("must fail");
    assert_eq!(
        err,
        format!(
            "auth failed for tester@{}:{} (key {} not usable: is encrypted, pass key_passphrase_file; password from {})",
            host(),
            port(),
            key.display(),
            pw_path.display()
        )
    );
    assert!(!err.contains("definitely-not-the-password-7f3a"));
}

#[tokio::test]
#[ignore]
async fn wrong_password_message() {
    let (dir, known) = known();
    let pw_path = dir.path().join("wrong.txt");
    std::fs::write(&pw_path, "definitely-not-the-password-7f3a").unwrap();
    let creds = Creds {
        password: Some(Secret::from_file(&pw_path).unwrap()),
        key: None,
    };
    let err = Session::connect(&target(), &creds, &known)
        .await
        .err()
        .expect("must fail");
    assert_eq!(
        err,
        format!(
            "auth failed for tester@{}:{} (password from {})",
            host(),
            port(),
            pw_path.display()
        )
    );
    assert!(!err.contains("definitely-not-the-password-7f3a"));
}

#[tokio::test]
#[ignore]
async fn nonzero_exit_is_ok() {
    let s = connect(&key_creds()).await;
    let out = s.exec("exit 3", Duration::from_secs(10)).await.unwrap();
    assert_eq!(out.exit, Some(3));
    assert_eq!(out.timed_out, None);
}

#[tokio::test]
#[ignore]
async fn timeout_returns_partial() {
    let s = connect(&key_creds()).await;
    let started = Instant::now();
    let out = s
        .exec("echo start; sleep 30", Duration::from_secs(2))
        .await
        .unwrap();
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "took {:?}",
        started.elapsed()
    );
    assert_eq!(out.timed_out, Some(2));
    assert!(String::from_utf8_lossy(&out.stdout).contains("start"));
}

#[tokio::test]
#[ignore]
async fn session_usable_after_timeout() {
    let s = connect(&key_creds()).await;
    let out = s
        .exec("echo start; sleep 30", Duration::from_secs(2))
        .await
        .unwrap();
    assert_eq!(out.timed_out, Some(2));
    assert!(!s.is_closed());
    let out = s.exec("echo ok", Duration::from_secs(10)).await.unwrap();
    assert_eq!(out.exit, Some(0));
    assert_eq!(out.stdout, b"ok\n");
}

#[tokio::test]
#[ignore]
async fn unreachable_host() {
    let (_dir, known) = known();
    let t = Target {
        host: host(),
        port: 2299,
        user: "tester".into(),
    };
    let started = Instant::now();
    let err = Session::connect(&t, &key_creds(), &known)
        .await
        .err()
        .expect("must fail");
    assert!(
        started.elapsed() < Duration::from_secs(11),
        "took {:?}",
        started.elapsed()
    );
    assert!(
        err.starts_with(&format!("cannot reach {}:2299", host())),
        "{err}"
    );
}

#[tokio::test]
#[ignore]
async fn known_host_recorded_then_changed() {
    let (_dir, known) = known();
    let creds = key_creds();

    let s = Session::connect(&target(), &creds, &known).await.unwrap();
    let first = s.exec("true", Duration::from_secs(10)).await.unwrap();
    assert_eq!(first.key_status, HostKeyStatus::New);
    drop(s);

    let s = Session::connect(&target(), &creds, &known).await.unwrap();
    let second = s.exec("true", Duration::from_secs(10)).await.unwrap();
    assert_eq!(second.key_status, HostKeyStatus::Match);
    drop(s);

    let justfile = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../justfile");
    let out = std::process::Command::new("just")
        .arg("--justfile")
        .arg(&justfile)
        .arg("ssh-test-server-reset")
        .output()
        .expect("run just ssh-test-server-reset");
    assert!(
        out.status.success(),
        "just ssh-test-server-reset failed: {}\nstdout:\n{}\nstderr:\n{}",
        out.status,
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );

    let s = Session::connect(&target(), &creds, &known).await.unwrap();
    let third = s.exec("true", Duration::from_secs(10)).await.unwrap();
    match third.key_status {
        HostKeyStatus::Changed { old, new } => {
            assert!(old.starts_with("SHA256:"), "{old}");
            assert!(new.starts_with("SHA256:"), "{new}");
            assert_ne!(old, new);
        }
        other => panic!("expected Changed, got {other:?}"),
    }
}

/// Unpauses the test container when dropped, so a failing test does not leave it paused.
struct Unpause;

impl Drop for Unpause {
    fn drop(&mut self) {
        let _ = std::process::Command::new("docker")
            .args(["unpause", "ssh-remote-test"])
            .output();
    }
}

#[tokio::test]
#[ignore]
async fn dead_link_times_out_then_closes() {
    let s = connect(&key_creds()).await;
    let out = tokio::task::spawn_blocking(|| {
        std::process::Command::new("docker")
            .args(["pause", "ssh-remote-test"])
            .output()
            .expect("run docker pause")
    })
    .await
    .unwrap();
    assert!(out.status.success(), "docker pause failed");
    let _unpause = Unpause;

    // The channel open never gets an answer; the call's timeout covers it.
    let started = Instant::now();
    let out = s.exec("echo hi", Duration::from_secs(2)).await.unwrap();
    assert_eq!(out.timed_out, Some(2));
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "took {:?}",
        started.elapsed()
    );

    // Unanswered keepalives (3 x 15 s) close the session.
    let deadline = Instant::now() + Duration::from_secs(90);
    while !s.is_closed() {
        assert!(
            Instant::now() < deadline,
            "session never noticed the dead link"
        );
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

// ---- Pool ----

fn pool(idle: Duration) -> (tempfile::TempDir, Pool) {
    let (dir, known) = known();
    (dir, Pool::new(known, idle))
}

/// Copies the test password into a temp file the test may delete.
fn temp_password_creds(dir: &std::path::Path, name: &str, from: &str) -> (PathBuf, Creds) {
    let path = dir.join(name);
    std::fs::copy(test_dir().join(from), &path).unwrap();
    let creds = Creds {
        password: Some(Secret::from_file(&path).unwrap()),
        key: None,
    };
    (path, creds)
}

async fn whoami(pool: &Pool, t: &Target, creds: Option<Creds>) -> Result<String, String> {
    pool.with_session(t, creds, async |s, _secrets| {
        let out = s.exec("whoami", Duration::from_secs(10)).await?;
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    })
    .await
}

#[tokio::test]
#[ignore]
async fn reuses_session_without_password_file() {
    let (dir, pool) = pool(Duration::from_secs(300));
    let (pw_path, creds) = temp_password_creds(dir.path(), "pw.txt", "pw.txt");
    assert_eq!(
        whoami(&pool, &target(), Some(creds)).await.unwrap(),
        "tester"
    );
    std::fs::remove_file(&pw_path).unwrap();
    assert_eq!(whoami(&pool, &target(), None).await.unwrap(), "tester");
}

#[tokio::test]
#[ignore]
async fn secrets_passed_to_f_mask_output() {
    let (_dir, pool) = pool(Duration::from_secs(300));
    let pw = std::fs::read_to_string(test_dir().join("pw.txt")).unwrap();
    let masked = pool
        .with_session(&target(), Some(password_creds()), async |s, secrets| {
            assert_eq!(secrets.len(), 1);
            let out = s
                .exec(&format!("echo {pw}"), Duration::from_secs(10))
                .await?;
            Ok(mask_all(secrets, &String::from_utf8_lossy(&out.stdout)))
        })
        .await
        .unwrap();
    assert!(!masked.contains(pw.trim()), "{masked}");
    assert!(masked.contains("***"), "{masked}");
}

#[tokio::test]
#[ignore]
async fn replaced_password_still_masked() {
    let (dir, pool) = pool(Duration::from_secs(300));
    let (_, creds) = temp_password_creds(dir.path(), "pw.txt", "pw.txt");
    let pw = std::fs::read_to_string(test_dir().join("pw.txt")).unwrap();
    assert_eq!(
        whoami(&pool, &target(), Some(creds)).await.unwrap(),
        "tester"
    );
    // Same open session, new credentials without a password: the old one still masks.
    let masked = pool
        .with_session(&target(), Some(key_creds()), async |s, secrets| {
            let out = s
                .exec(&format!("echo {pw}"), Duration::from_secs(10))
                .await?;
            Ok(mask_all(secrets, &String::from_utf8_lossy(&out.stdout)))
        })
        .await
        .unwrap();
    assert!(!masked.contains(pw.trim()), "{masked}");
    assert_eq!(masked.trim(), "***");
    // Errors from `f` are masked by the pool too.
    let err = pool
        .with_session(&target(), None, async |_s, _secrets| {
            Err::<(), _>(format!("boom {pw}"))
        })
        .await
        .unwrap_err();
    assert_eq!(err, "boom ***");
}

fn other_target() -> Target {
    Target {
        host: host(),
        port: 2223,
        user: "other".into(),
    }
}

#[tokio::test]
#[ignore]
async fn different_users_are_separate_entries() {
    let (dir, pool) = pool(Duration::from_secs(300));
    let (_, tester) = temp_password_creds(dir.path(), "pw.txt", "pw.txt");
    let (_, other) = temp_password_creds(dir.path(), "pw-other.txt", "pw-other.txt");
    assert_ne!(
        std::fs::read(test_dir().join("pw.txt")).unwrap(),
        std::fs::read(test_dir().join("pw-other.txt")).unwrap()
    );
    let err = whoami(&pool, &other_target(), None).await.err().unwrap();
    assert!(err.starts_with("no credentials for other@"), "{err}");
    assert_eq!(
        whoami(&pool, &target(), Some(tester)).await.unwrap(),
        "tester"
    );
    let err = whoami(&pool, &other_target(), None).await.err().unwrap();
    assert!(err.starts_with("no credentials for other@"), "{err}");
    assert_eq!(
        whoami(&pool, &other_target(), Some(other)).await.unwrap(),
        "other"
    );
    assert_eq!(whoami(&pool, &target(), None).await.unwrap(), "tester");
    assert_eq!(whoami(&pool, &other_target(), None).await.unwrap(), "other");
}

#[tokio::test]
#[ignore]
async fn idle_expiry() {
    let (_dir, pool) = pool(Duration::from_secs(1));
    assert_eq!(
        whoami(&pool, &target(), Some(password_creds()))
            .await
            .unwrap(),
        "tester"
    );
    tokio::time::sleep(Duration::from_secs(2)).await;
    let err = whoami(&pool, &target(), None).await.err().unwrap();
    assert!(err.starts_with("no credentials for tester@"), "{err}");
}

#[tokio::test]
#[ignore]
async fn changed_host_key_reported_once_per_connection() {
    let (dir, known) = known();
    // A stale fingerprint for the test server makes the first connect see a changed key.
    std::fs::write(
        dir.path().join("known_hosts"),
        format!("{}:{} SHA256:stale-fingerprint\n", host(), port()),
    )
    .unwrap();
    let pool = Pool::new(known, Duration::from_secs(300));
    let status = async |creds: Option<Creds>| {
        pool.with_session(&target(), creds, async |s, _secrets| {
            Ok(s.exec("true", Duration::from_secs(10)).await?.key_status)
        })
        .await
        .unwrap()
    };
    match status(Some(key_creds())).await {
        HostKeyStatus::Changed { old, .. } => assert_eq!(old, "SHA256:stale-fingerprint"),
        other => panic!("expected Changed, got {other:?}"),
    }
    assert_eq!(status(None).await, HostKeyStatus::Match);
}

#[tokio::test]
#[ignore]
async fn reconnects_closed_session_once() {
    let (_dir, pool) = pool(Duration::from_secs(300));
    assert_eq!(
        whoami(&pool, &target(), Some(key_creds())).await.unwrap(),
        "tester"
    );
    // Restarting the container kills the connection but keeps host keys and credentials. The
    // commands run off the runtime thread so russh's session task can see the disconnect.
    tokio::task::spawn_blocking(|| {
        let out = std::process::Command::new("docker")
            .args(["restart", "ssh-remote-test"])
            .output()
            .expect("run docker restart");
        assert!(out.status.success(), "docker restart failed");
        let justfile = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../justfile");
        let out = std::process::Command::new("just")
            .arg("--justfile")
            .arg(&justfile)
            .arg("ssh-test-server")
            .output()
            .expect("run just ssh-test-server");
        assert!(out.status.success(), "just ssh-test-server failed");
    })
    .await
    .unwrap();
    // The restart and banner wait take seconds, long enough for the client to see the drop;
    // the call then reconnects with the stored credentials.
    assert_eq!(whoami(&pool, &target(), None).await.unwrap(), "tester");
}

#[tokio::test]
#[ignore]
async fn changed_host_key_survives_failed_first_call() {
    let (dir, known) = known();
    std::fs::write(
        dir.path().join("known_hosts"),
        format!("{}:{} SHA256:stale-fingerprint\n", host(), port()),
    )
    .unwrap();
    let pool = Pool::new(known, Duration::from_secs(300));
    let err = pool
        .with_session(&target(), Some(key_creds()), async |_s, _secrets| {
            Err::<(), _>("channel failed".to_string())
        })
        .await
        .err()
        .unwrap();
    assert_eq!(err, "channel failed");
    let status = async || {
        pool.with_session(&target(), None, async |s, _secrets| {
            Ok(s.key_status.clone())
        })
        .await
        .unwrap()
    };
    match status().await {
        HostKeyStatus::Changed { old, .. } => assert_eq!(old, "SHA256:stale-fingerprint"),
        other => panic!("expected Changed after a failed first call, got {other:?}"),
    }
    assert_eq!(status().await, HostKeyStatus::Match);
}

mod download {
    use super::*;
    use ssh_remote::transfer::download;

    async fn put(s: &Session, remote: &str, content: &str) {
        let out = s
            .exec(
                &format!("printf %s '{content}' > {remote}"),
                Duration::from_secs(10),
            )
            .await
            .unwrap();
        assert_eq!(out.exit, Some(0));
    }

    #[tokio::test]
    #[ignore]
    async fn downloads_file() {
        let s = connect(&key_creds()).await;
        put(&s, "/tmp/f.txt", "ssh").await;
        let dir = tempfile::tempdir().unwrap();
        let local = dir.path().join("f.txt");
        let n = download(&s, "/tmp/f.txt", &local, 1000, Duration::from_secs(60))
            .await
            .unwrap();
        assert_eq!(n, 3);
        assert_eq!(std::fs::read(&local).unwrap(), b"ssh");
    }

    #[tokio::test]
    #[ignore]
    async fn creates_parent_dirs() {
        let s = connect(&key_creds()).await;
        put(&s, "/tmp/f.txt", "ssh").await;
        let dir = tempfile::tempdir().unwrap();
        let local = dir.path().join("a").join("b").join("f.txt");
        download(&s, "/tmp/f.txt", &local, 1000, Duration::from_secs(60))
            .await
            .unwrap();
        assert_eq!(std::fs::read(&local).unwrap(), b"ssh");
    }

    #[tokio::test]
    #[ignore]
    async fn refuses_over_cap() {
        let s = connect(&key_creds()).await;
        put(&s, "/tmp/big.txt", "12345678901").await;
        let dir = tempfile::tempdir().unwrap();
        let local = dir.path().join("big.txt");
        let e = download(&s, "/tmp/big.txt", &local, 10, Duration::from_secs(60))
            .await
            .unwrap_err();
        assert!(e.contains("limit is"), "{e}");
        assert!(e.contains("/tmp/big.txt"), "{e}");
        assert!(!local.exists());
    }

    #[tokio::test]
    #[ignore]
    async fn download_times_out() {
        let s = connect(&key_creds()).await;
        // Opening a FIFO with no writer blocks the SFTP server.
        let out = s
            .exec(
                "rm -f /tmp/fifo && mkfifo /tmp/fifo",
                Duration::from_secs(10),
            )
            .await
            .unwrap();
        assert_eq!(out.exit, Some(0));
        let dir = tempfile::tempdir().unwrap();
        let local = dir.path().join("fifo");
        let started = Instant::now();
        let e = download(&s, "/tmp/fifo", &local, 1000, Duration::from_secs(2))
            .await
            .unwrap_err();
        assert!(started.elapsed() < Duration::from_secs(5));
        assert_eq!(e, "download of /tmp/fifo timed out after 2 s");
        assert!(!local.exists());
        assert!(!dir.path().join("fifo.part").exists());
    }

    #[tokio::test]
    #[ignore]
    async fn missing_remote_file() {
        let s = connect(&password_creds()).await;
        let dir = tempfile::tempdir().unwrap();
        let local = dir.path().join("x");
        let e = download(
            &s,
            "/tmp/does-not-exist.txt",
            &local,
            1000,
            Duration::from_secs(60),
        )
        .await
        .unwrap_err();
        assert!(e.contains("/tmp/does-not-exist.txt"), "{e}");
        assert!(!local.exists());
    }
}

/// A minimal MCP stdio client for the built server. LOCALAPPDATA points at a tempdir so the
/// server's known_hosts stays out of the user's real one.
struct McpClient {
    child: std::process::Child,
    stdin: std::process::ChildStdin,
    stdout: std::io::BufReader<std::process::ChildStdout>,
    next_id: u64,
    _appdata: tempfile::TempDir,
}

impl McpClient {
    fn start() -> McpClient {
        use std::io::Write;
        use std::process::{Command, Stdio};
        let appdata = tempfile::tempdir().unwrap();
        let mut child = Command::new(env!("CARGO_BIN_EXE_ssh-remote"))
            .env("LOCALAPPDATA", appdata.path())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn server");
        let stdin = child.stdin.take().unwrap();
        let stdout = std::io::BufReader::new(child.stdout.take().unwrap());
        let mut c = McpClient {
            child,
            stdin,
            stdout,
            next_id: 1,
            _appdata: appdata,
        };
        c.request(
            "initialize",
            serde_json::json!({"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"0"}}),
        );
        writeln!(
            c.stdin,
            "{}",
            serde_json::json!({"jsonrpc":"2.0","method":"notifications/initialized"})
        )
        .unwrap();
        c
    }

    fn request(&mut self, method: &str, params: serde_json::Value) -> serde_json::Value {
        use std::io::{BufRead, Write};
        let id = self.next_id;
        self.next_id += 1;
        writeln!(
            self.stdin,
            "{}",
            serde_json::json!({"jsonrpc":"2.0","id":id,"method":method,"params":params})
        )
        .unwrap();
        let mut line = String::new();
        self.stdout.read_line(&mut line).unwrap();
        serde_json::from_str(&line).unwrap()
    }

    /// Calls a tool and returns (is_error, text).
    fn call(&mut self, name: &str, arguments: serde_json::Value) -> (bool, String) {
        let r = self.request(
            "tools/call",
            serde_json::json!({"name": name, "arguments": arguments}),
        );
        let is_error = r["result"]["isError"] == true;
        let text = r["result"]["content"][0]["text"]
            .as_str()
            .unwrap_or_else(|| panic!("no text in response"))
            .to_string();
        (is_error, text)
    }
}

impl Drop for McpClient {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

#[test]
#[ignore]
fn server_masks_password_and_reuses_session() {
    let pw_file = test_dir().join("pw.txt");
    let password = Secret::from_file(&pw_file).unwrap();
    let mut c = McpClient::start();
    let base = serde_json::json!({"host": host(), "port": port(), "user": "tester"});

    let mut args = base.clone();
    args["password_file"] = pw_file.to_str().unwrap().into();
    args["command"] = "cat /pw; echo; echo done".into();
    let (is_error, text) = c.call("ssh", args);
    assert!(!is_error, "{}", password.mask(&text));
    assert!(!text.contains(password.expose()), "password leaked");
    assert!(text.contains("***"), "{text}");
    assert!(
        text.starts_with(&format!("tester@{} · exit 0 · ", host())),
        "{text}"
    );

    // No credentials: the open session is reused.
    let mut args = base.clone();
    args["command"] = "exit 3".into();
    let (is_error, text) = c.call("ssh", args);
    assert!(!is_error, "{text}");
    assert!(text.contains("· exit 3 ·"), "{text}");

    let dir = tempfile::tempdir().unwrap();
    let local = dir.path().join("hostname");
    std::fs::write(&local, "old").unwrap();
    let mut args = base.clone();
    args["remote_path"] = "/etc/hostname".into();
    args["local_path"] = local.to_str().unwrap().into();
    let (is_error, text) = c.call("ssh_download", args);
    assert!(!is_error, "{text}");
    assert!(text.starts_with("downloaded /etc/hostname → "), "{text}");
    assert_ne!(std::fs::read_to_string(&local).unwrap(), "old");
}

#[test]
#[ignore]
fn server_reports_connect_failure_as_tool_error() {
    let mut c = McpClient::start();
    let (is_error, text) = c.call(
        "ssh",
        serde_json::json!({"host": host(), "port": port(), "user": "tester",
            "password_file": test_dir().join("pw-other.txt").to_str().unwrap(), "command": "true"}),
    );
    assert!(is_error, "{text}");
    let other = Secret::from_file(&test_dir().join("pw-other.txt")).unwrap();
    assert!(!text.contains(other.expose()), "password leaked");
    assert!(!text.contains('\n'), "{text}");
}

#[test]
#[ignore]
fn server_masks_replaced_password() {
    let pw_file = test_dir().join("pw.txt");
    let password = Secret::from_file(&pw_file).unwrap();
    let mut c = McpClient::start();
    let base = serde_json::json!({"host": host(), "port": port(), "user": "tester"});

    let mut args = base.clone();
    args["password_file"] = pw_file.to_str().unwrap().into();
    args["command"] = "true".into();
    let (is_error, text) = c.call("ssh", args);
    assert!(!is_error, "{}", password.mask(&text));

    // Second call on the same session passes only a key; the first password stays masked.
    let mut args = base.clone();
    args["key_file"] = test_dir().join("id_ed25519").to_str().unwrap().into();
    args["command"] = "cat /pw; echo".into();
    let (is_error, text) = c.call("ssh", args);
    assert!(!is_error, "{}", password.mask(&text));
    assert!(!text.contains(password.expose()), "password leaked");
    assert!(text.lines().any(|l| l == "***"), "{text}");
}

#[test]
#[ignore]
fn server_trims_one_long_line() {
    let mut c = McpClient::start();
    let args = serde_json::json!({"host": host(), "port": port(), "user": "tester",
        "key_file": test_dir().join("id_ed25519").to_str().unwrap(),
        "command": "head -c 1000000 /dev/zero | tr '\\000' a; echo"});
    let (is_error, text) = c.call("ssh", args);
    assert!(!is_error, "{text}");
    assert!(text.len() < 110_000, "{}", text.len());
    assert!(text.contains("characters omitted"), "no char trim marker");
    let path_line = text
        .lines()
        .find(|l| l.starts_with("full output: "))
        .expect("no full output line");
    let path = PathBuf::from(path_line.trim_start_matches("full output: "));
    assert_eq!(std::fs::read(&path).unwrap().len(), 1_000_001);
    let _ = std::fs::remove_file(&path);
}
