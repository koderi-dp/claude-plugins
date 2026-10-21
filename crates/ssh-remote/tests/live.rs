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
        pool.with_session(&target(), None, async |s, _secrets| Ok(s.key_status.clone()))
            .await
            .unwrap()
    };
    match status().await {
        HostKeyStatus::Changed { old, .. } => assert_eq!(old, "SHA256:stale-fingerprint"),
        other => panic!("expected Changed after a failed first call, got {other:?}"),
    }
    assert_eq!(status().await, HostKeyStatus::Match);
}
