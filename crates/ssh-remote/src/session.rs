//! One authenticated SSH connection: connect with auto-trusted host keys, authenticate with a
//! key and/or password read from files, and run commands with a timeout.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use russh::client::{self, AuthResult, KeyboardInteractiveAuthResponse, Prompt};
use russh::keys::{self, Algorithm, HashAlg, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use russh::{ChannelMsg, MethodKind, MethodSet, Preferred, Sig, kex, mac};

use crate::format::{CAPTURE_HALF, Capture, ExecOutcome};
use crate::known_hosts::{HostKeyStatus, KnownHosts};
use crate::secret::Secret;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Keepalives notice a silently dead link: after `KEEPALIVE_MAX` unanswered ones the session
/// closes, so the pool reconnects on the next call.
const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(15);
const KEEPALIVE_MAX: usize = 3;
/// Keyboard-interactive prompt rounds answered before giving up.
const KBD_ROUNDS: usize = 3;

/// Credentials for one user. The key is a path plus an optional passphrase. Each `Secret`
/// remembers its file, so errors can name it.
pub struct Creds {
    pub password: Option<Secret>,
    pub key: Option<(PathBuf, Option<Secret>)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub host: String,
    pub port: u16,
    pub user: String,
}

pub struct Session {
    handle: client::Handle<Handler>,
    host: String,
    user: String,
    /// The host-key check result from connect time.
    pub key_status: HostKeyStatus,
}

/// Serialises known-hosts updates, so parallel connects do not lose each other's lines.
static KNOWN_HOSTS_LOCK: Mutex<()> = Mutex::new(());

/// `check_and_record` under the process-wide known-hosts lock.
fn record_host_key(
    known: &KnownHosts,
    host: &str,
    port: u16,
    fingerprint: &str,
) -> std::io::Result<HostKeyStatus> {
    let _guard = KNOWN_HOSTS_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    known.check_and_record(host, port, fingerprint)
}

/// What `check_server_key` saw: the known-hosts outcome, or why it could not be recorded.
type KeyCheck = Arc<Mutex<Option<Result<HostKeyStatus, String>>>>;

struct Handler {
    host: String,
    port: u16,
    known: KnownHosts,
    seen: KeyCheck,
}

impl client::Handler for Handler {
    type Error = russh::Error;

    /// Host keys are always accepted; the known-hosts file only records them.
    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let fingerprint = match server_public_key {
            PublicKeyOrCertificate::PublicKey { key, .. } => key.fingerprint(HashAlg::Sha256),
            PublicKeyOrCertificate::Certificate(cert) => {
                cert.public_key().fingerprint(HashAlg::Sha256)
            }
        }
        .to_string();
        let status =
            record_host_key(&self.known, &self.host, self.port, &fingerprint).map_err(|e| {
                format!(
                    "cannot record host key for {}:{}: {e}",
                    self.host, self.port
                )
            });
        *self.seen.lock().unwrap() = Some(status);
        Ok(true)
    }
}

/// russh's defaults plus legacy algorithms for older servers, appended after the defaults so
/// a modern server still negotiates a modern algorithm.
fn config() -> client::Config {
    let mut preferred = Preferred::DEFAULT.clone();
    let ssh_rsa = Algorithm::Rsa { hash: None };
    if !preferred.key.contains(&ssh_rsa) {
        preferred.key.to_mut().push(ssh_rsa);
    }
    let kexes = preferred.kex.to_mut();
    // Pseudo-algorithms (ext-info, strict kex) stay at the end of the list.
    let at = kexes
        .iter()
        .position(|n| n.as_ref() == kex::EXTENSION_SUPPORT_AS_CLIENT.as_ref())
        .unwrap_or(kexes.len());
    kexes.splice(at..at, [kex::DH_G14_SHA1, kex::DH_GEX_SHA1]);
    preferred
        .mac
        .to_mut()
        .extend([mac::HMAC_SHA1_ETM, mac::HMAC_SHA1]);
    client::Config {
        preferred,
        keepalive_interval: Some(KEEPALIVE_INTERVAL),
        keepalive_max: KEEPALIVE_MAX,
        ..Default::default()
    }
}

/// What happened to the key, for the auth-failure message.
enum KeyUse<'a> {
    Tried(&'a Path),
    /// The key file could not be loaded; the reason in its short form.
    Unusable(&'a Path, String),
}

fn auth_failed(t: &Target, key: Option<&KeyUse>, password: Option<&Path>) -> String {
    let key_part = key.map(|k| match k {
        KeyUse::Tried(p) => format!("tried key {}", p.display()),
        KeyUse::Unusable(p, why) => format!("key {} not usable: {why}", p.display()),
    });
    let pw_part = password.map(|p| format!("password from {}", p.display()));
    let sep = match key {
        Some(KeyUse::Unusable(..)) => "; ",
        _ => ", ",
    };
    let parts = match (key_part, pw_part) {
        (Some(k), Some(p)) => format!("{k}{sep}{p}"),
        (Some(k), None) => k,
        (None, Some(p)) => p,
        (None, None) => "no credentials".to_string(),
    };
    format!("auth failed for {}@{}:{} ({parts})", t.user, t.host, t.port)
}

/// Why a key file could not be loaded. Never holds secret text.
#[derive(Debug, PartialEq, Eq)]
enum KeyProblem {
    Encrypted,
    NotFound,
    Unreadable(std::io::ErrorKind),
    BadPassphrase(PathBuf),
    Invalid(String),
}

impl KeyProblem {
    fn new(passphrase: Option<&Secret>, e: keys::Error) -> KeyProblem {
        match (e, passphrase) {
            (keys::Error::KeyIsEncrypted, None) => KeyProblem::Encrypted,
            (keys::Error::IO(e), _) if e.kind() == std::io::ErrorKind::NotFound => {
                KeyProblem::NotFound
            }
            (keys::Error::IO(e), _) => KeyProblem::Unreadable(e.kind()),
            (_, Some(p)) => KeyProblem::BadPassphrase(p.source().to_path_buf()),
            (e, None) => KeyProblem::Invalid(e.to_string()),
        }
    }

    /// The error when the key was the only credential.
    fn message(&self, path: &Path) -> String {
        let shown = path.display();
        match self {
            KeyProblem::Encrypted => format!("key {shown} is encrypted: pass key_passphrase_file"),
            KeyProblem::NotFound => format!("key {shown}: not found"),
            KeyProblem::Unreadable(kind) => format!("key {shown}: cannot read ({kind})"),
            KeyProblem::BadPassphrase(p) => format!(
                "key {shown}: cannot load with the passphrase from {} (wrong passphrase or unsupported key)",
                p.display()
            ),
            KeyProblem::Invalid(e) => format!("key {shown}: cannot load ({e})"),
        }
    }

    /// The reason inside a combined auth-failure message.
    fn short(&self) -> String {
        match self {
            KeyProblem::Encrypted => "is encrypted, pass key_passphrase_file".to_string(),
            KeyProblem::NotFound => "not found".to_string(),
            KeyProblem::Unreadable(kind) => format!("cannot read ({kind})"),
            KeyProblem::BadPassphrase(p) => {
                format!("cannot load with the passphrase from {}", p.display())
            }
            KeyProblem::Invalid(e) => format!("cannot load ({e})"),
        }
    }
}

/// Whether keyboard-interactive is worth trying after a password failure. An empty list means
/// the server did not say.
fn offers_keyboard_interactive(remaining: &MethodSet) -> bool {
    remaining.is_empty() || remaining.contains(&MethodKind::KeyboardInteractive)
}

/// Keyboard-interactive with the password: answers up to `KBD_ROUNDS` prompt rounds. True on
/// success.
async fn keyboard_interactive(
    handle: &mut client::Handle<Handler>,
    user: &str,
    pw: &Secret,
) -> Result<bool, russh::Error> {
    let mut resp = handle
        .authenticate_keyboard_interactive_start(user, None::<String>)
        .await?;
    for _ in 0..KBD_ROUNDS {
        match resp {
            KeyboardInteractiveAuthResponse::Success => return Ok(true),
            KeyboardInteractiveAuthResponse::Failure { .. } => return Ok(false),
            KeyboardInteractiveAuthResponse::InfoRequest { prompts, .. } => {
                resp = handle
                    .authenticate_keyboard_interactive_respond(kbd_answers(&prompts, pw.expose()))
                    .await?;
            }
        }
    }
    Ok(matches!(resp, KeyboardInteractiveAuthResponse::Success))
}

/// The password for every hidden prompt, an empty answer for every echoed one (those ask for
/// something other than the password, e.g. a user name or a banner acknowledgement).
fn kbd_answers(prompts: &[Prompt], pw: &str) -> Vec<String> {
    prompts
        .iter()
        .map(|p| {
            if p.echo {
                String::new()
            } else {
                pw.to_string()
            }
        })
        .collect()
}

/// The signal name without the `SIG` prefix, as SSH sends it.
fn sig_name(sig: &Sig) -> String {
    match sig {
        Sig::ABRT => "ABRT",
        Sig::ALRM => "ALRM",
        Sig::FPE => "FPE",
        Sig::HUP => "HUP",
        Sig::ILL => "ILL",
        Sig::INT => "INT",
        Sig::KILL => "KILL",
        Sig::PIPE => "PIPE",
        Sig::QUIT => "QUIT",
        Sig::SEGV => "SEGV",
        Sig::TERM => "TERM",
        Sig::USR1 => "USR1",
        Sig::Custom(name) => name,
    }
    .to_string()
}

fn reach_error(t: &Target, e: &russh::Error) -> String {
    let why = match e {
        russh::Error::IO(io) => match io.kind() {
            std::io::ErrorKind::ConnectionRefused => "connection refused".to_string(),
            std::io::ErrorKind::TimedOut => "connection timed out".to_string(),
            _ => io.to_string(),
        },
        other => format!("ssh handshake failed: {other}"),
    };
    format!("cannot reach {}:{}: {why}", t.host, t.port)
}

impl Session {
    pub async fn connect(t: &Target, creds: &Creds, known: &KnownHosts) -> Result<Session, String> {
        if creds.password.is_none() && creds.key.is_none() {
            return Err(format!(
                "no credentials for {}@{}: pass password_file or key_file",
                t.user, t.host
            ));
        }
        // Load the key before touching the network. A key that cannot be loaded is an error
        // only when there is no password to fall back to.
        let mut key = None;
        let mut key_problem = None;
        if let Some((path, passphrase)) = &creds.key {
            let pass = passphrase.as_ref();
            match keys::load_secret_key(path, pass.map(Secret::expose)) {
                Ok(k) => key = Some((path.as_path(), k)),
                Err(e) => {
                    let problem = KeyProblem::new(pass, e);
                    if creds.password.is_none() {
                        return Err(problem.message(path));
                    }
                    key_problem = Some((path.as_path(), problem));
                }
            }
        }

        let seen: KeyCheck = Arc::default();
        let handler = Handler {
            host: t.host.clone(),
            port: t.port,
            known: known.clone(),
            seen: seen.clone(),
        };
        let addr = (t.host.as_str(), t.port);
        let mut handle = match tokio::time::timeout(
            CONNECT_TIMEOUT,
            client::connect(Arc::new(config()), addr, handler),
        )
        .await
        {
            Err(_) => {
                return Err(format!(
                    "cannot reach {}:{}: connection timed out after {} s",
                    t.host,
                    t.port,
                    CONNECT_TIMEOUT.as_secs()
                ));
            }
            Ok(Err(e)) => return Err(reach_error(t, &e)),
            Ok(Ok(h)) => h,
        };
        let key_status =
            seen.lock().unwrap().take().ok_or_else(|| {
                format!("cannot reach {}:{}: no host key received", t.host, t.port)
            })??;

        let auth = async {
            let transport =
                |e: russh::Error| format!("auth for {}@{}:{} failed: {e}", t.user, t.host, t.port);
            if let Some((_, k)) = &key {
                let hash = if k.algorithm().is_rsa() {
                    handle
                        .best_supported_rsa_hash()
                        .await
                        .map_err(transport)?
                        .flatten()
                } else {
                    None
                };
                let k = PrivateKeyWithHashAlg::new(Arc::new(k.clone()), hash);
                if let AuthResult::Success = handle
                    .authenticate_publickey(&t.user, k)
                    .await
                    .map_err(transport)?
                {
                    return Ok(());
                }
            }
            if let Some(pw) = &creds.password {
                let offered = match handle
                    .authenticate_password(&t.user, pw.expose())
                    .await
                    .map_err(transport)?
                {
                    AuthResult::Success => return Ok(()),
                    AuthResult::Failure {
                        remaining_methods, ..
                    } => offers_keyboard_interactive(&remaining_methods),
                };
                // Servers that take passwords only through PAM ask for them this way.
                if offered
                    && keyboard_interactive(&mut handle, &t.user, pw)
                        .await
                        .map_err(transport)?
                {
                    return Ok(());
                }
            }
            let key_use = match (&key, &key_problem) {
                (Some((p, _)), _) => Some(KeyUse::Tried(p)),
                (None, Some((p, why))) => Some(KeyUse::Unusable(p, why.short())),
                (None, None) => None,
            };
            Err(auth_failed(
                t,
                key_use.as_ref(),
                creds.password.as_ref().map(Secret::source),
            ))
        };
        match tokio::time::timeout(CONNECT_TIMEOUT, auth).await {
            Err(_) => {
                return Err(format!(
                    "auth for {}@{}:{} timed out after {} s",
                    t.user,
                    t.host,
                    t.port,
                    CONNECT_TIMEOUT.as_secs()
                ));
            }
            Ok(r) => r?,
        }

        Ok(Session {
            handle,
            host: t.host.clone(),
            user: t.user.clone(),
            key_status,
        })
    }

    /// Runs `command`, collecting stdout, stderr and the exit status. `timeout` covers opening
    /// the channel, starting the command and reading its output. On timeout the channel is
    /// closed and the partial output returned with `timed_out` set; the session stays usable.
    pub async fn exec(&self, command: &str, timeout: Duration) -> Result<ExecOutcome, String> {
        let started = Instant::now();
        let deadline = tokio::time::Instant::now() + timeout;
        let fail =
            |what: &str, e: russh::Error| format!("{what} on {}@{}: {e}", self.user, self.host);
        let mut stdout = Capture::new(CAPTURE_HALF);
        let mut stderr = Capture::new(CAPTURE_HALF);
        let mut exit = None;
        let mut signal = None;
        let outcome = |stdout: Capture, stderr: Capture, exit, signal, timed_out| {
            let (stdout, stdout_cut) = stdout.finish();
            let (stderr, stderr_cut) = stderr.finish();
            ExecOutcome {
                user: self.user.clone(),
                host: self.host.clone(),
                exit,
                signal,
                elapsed: started.elapsed(),
                stdout,
                stderr,
                stdout_cut,
                stderr_cut,
                timed_out,
                key_status: self.key_status.clone(),
            }
        };
        let expired = Some(timeout.as_secs());

        let Ok(opened) =
            tokio::time::timeout_at(deadline, self.handle.channel_open_session()).await
        else {
            return Ok(outcome(stdout, stderr, exit, signal, expired));
        };
        let mut channel = opened.map_err(|e| fail("cannot open a channel", e))?;
        match tokio::time::timeout_at(deadline, channel.exec(true, command)).await {
            Err(_) => {
                let _ = channel.close().await;
                return Ok(outcome(stdout, stderr, exit, signal, expired));
            }
            Ok(r) => r.map_err(|e| fail("cannot run the command", e))?,
        }

        let read = async {
            // The exit status usually arrives after Eof, so read until Close.
            while let Some(msg) = channel.wait().await {
                match msg {
                    ChannelMsg::Data { data } => stdout.push(&data),
                    ChannelMsg::ExtendedData { data, ext: 1 } => stderr.push(&data),
                    ChannelMsg::ExitStatus { exit_status } => exit = Some(exit_status),
                    ChannelMsg::ExitSignal { signal_name, .. } => {
                        signal = Some(sig_name(&signal_name));
                    }
                    ChannelMsg::Failure => {
                        return Err(format!(
                            "{}@{} refused to run the command",
                            self.user, self.host
                        ));
                    }
                    ChannelMsg::Close => break,
                    _ => {}
                }
            }
            Ok(())
        };
        let finished = match tokio::time::timeout_at(deadline, read).await {
            Ok(r) => {
                r?;
                true
            }
            Err(_) => false,
        };
        if !finished {
            let _ = channel.close().await;
        }
        Ok(outcome(
            stdout,
            stderr,
            exit,
            signal,
            expired.filter(|_| !finished),
        ))
    }

    /// Opens an SFTP session on a fresh channel.
    pub async fn sftp(&self) -> Result<russh_sftp::client::SftpSession, String> {
        let fail = |what: &str, e: &dyn std::fmt::Display| {
            format!("{what} on {}@{}: {e}", self.user, self.host)
        };
        let channel = self
            .handle
            .channel_open_session()
            .await
            .map_err(|e| fail("cannot open a channel", &e))?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|e| fail("the server refused the sftp subsystem", &e))?;
        russh_sftp::client::SftpSession::new(channel.into_stream())
            .await
            .map_err(|e| fail("cannot start sftp", &e))
    }

    pub fn is_closed(&self) -> bool {
        self.handle.is_closed()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t() -> Target {
        Target {
            host: "10.0.0.21".into(),
            port: 22,
            user: "root".into(),
        }
    }

    #[test]
    fn auth_failed_names_every_file_tried() {
        let k = Path::new(r"C:\keys\id_ed25519");
        let p = Path::new(r"C:\temp\pw.txt");
        let tried = KeyUse::Tried(k);
        assert_eq!(
            auth_failed(&t(), Some(&tried), Some(p)),
            r"auth failed for root@10.0.0.21:22 (tried key C:\keys\id_ed25519, password from C:\temp\pw.txt)"
        );
        assert_eq!(
            auth_failed(&t(), Some(&tried), None),
            r"auth failed for root@10.0.0.21:22 (tried key C:\keys\id_ed25519)"
        );
        assert_eq!(
            auth_failed(&t(), None, Some(p)),
            r"auth failed for root@10.0.0.21:22 (password from C:\temp\pw.txt)"
        );
    }

    #[test]
    fn auth_failed_names_unusable_key_and_password_file() {
        let k = Path::new(r"C:\keys\id_enc");
        let p = Path::new(r"C:\temp\pw.txt");
        let unusable = KeyUse::Unusable(k, KeyProblem::Encrypted.short());
        assert_eq!(
            auth_failed(&t(), Some(&unusable), Some(p)),
            r"auth failed for root@10.0.0.21:22 (key C:\keys\id_enc not usable: is encrypted, pass key_passphrase_file; password from C:\temp\pw.txt)"
        );

        // A wrong passphrase names the passphrase file, never its contents.
        let d = tempfile::tempdir().unwrap();
        let pf = d.path().join("pass.txt");
        std::fs::write(&pf, "hunter2-passphrase").unwrap();
        let pass = Secret::from_file(&pf).unwrap();
        let why = KeyProblem::new(Some(&pass), keys::Error::CouldNotReadKey).short();
        let msg = auth_failed(&t(), Some(&KeyUse::Unusable(k, why)), Some(p));
        assert!(msg.contains(&pf.display().to_string()), "{msg}");
        assert!(msg.contains(r"C:\temp\pw.txt"), "{msg}");
        assert!(!msg.contains("hunter2"), "{msg}");
    }

    #[test]
    fn encrypted_key_without_passphrase_message() {
        let msg =
            KeyProblem::new(None, keys::Error::KeyIsEncrypted).message(Path::new(r"C:\k\id_rsa"));
        assert_eq!(
            msg,
            r"key C:\k\id_rsa is encrypted: pass key_passphrase_file"
        );
    }

    #[test]
    fn missing_key_file_message() {
        let e = keys::Error::IO(std::io::Error::from(std::io::ErrorKind::NotFound));
        assert_eq!(
            KeyProblem::new(None, e).message(Path::new(r"C:\k\nope")),
            r"key C:\k\nope: not found"
        );
    }

    #[test]
    fn wrong_passphrase_names_passphrase_file_not_contents() {
        let d = tempfile::tempdir().unwrap();
        let pf = d.path().join("pass.txt");
        std::fs::write(&pf, "hunter2-passphrase").unwrap();
        let pass = Secret::from_file(&pf).unwrap();
        let msg = KeyProblem::new(Some(&pass), keys::Error::CouldNotReadKey)
            .message(Path::new(r"C:\k\id"));
        assert!(msg.contains(&pf.display().to_string()), "{msg}");
        assert!(!msg.contains("hunter2"), "{msg}");
    }

    #[test]
    fn kbd_answers_password_only_for_hidden_prompts() {
        let prompt = |text: &str, echo| Prompt {
            prompt: text.into(),
            echo,
        };
        let prompts = [
            prompt("Password: ", false),
            prompt("Login name: ", true),
            prompt("Verification: ", false),
        ];
        assert_eq!(kbd_answers(&prompts, "pw"), ["pw", "", "pw"]);
        assert!(kbd_answers(&[], "pw").is_empty());
    }

    #[test]
    fn keyboard_interactive_only_when_offered() {
        let set = |m: &[MethodKind]| MethodSet::from(m);
        assert!(offers_keyboard_interactive(&set(&[
            MethodKind::Password,
            MethodKind::KeyboardInteractive
        ])));
        assert!(offers_keyboard_interactive(&set(&[])));
        assert!(!offers_keyboard_interactive(&set(&[MethodKind::PublicKey])));
    }

    #[test]
    fn parallel_host_key_records_all_land() {
        let d = tempfile::tempdir().unwrap();
        let known = KnownHosts::new(d.path().join("known_hosts"));
        std::thread::scope(|scope| {
            for i in 0..16 {
                let known = &known;
                scope.spawn(move || {
                    record_host_key(known, &format!("h{i}"), 22, "SHA256:x").unwrap();
                });
            }
        });
        let text = std::fs::read_to_string(d.path().join("known_hosts")).unwrap();
        assert_eq!(text.lines().count(), 16, "{text}");
    }

    #[test]
    fn signal_names() {
        assert_eq!(sig_name(&Sig::KILL), "KILL");
        assert_eq!(sig_name(&Sig::Custom("USR2".into())), "USR2");
    }

    #[test]
    fn refused_connection_message() {
        let e = russh::Error::IO(std::io::Error::from(std::io::ErrorKind::ConnectionRefused));
        assert_eq!(
            reach_error(&t(), &e),
            "cannot reach 10.0.0.21:22: connection refused"
        );
    }

    #[test]
    fn config_keeps_defaults_first_and_adds_legacy() {
        let c = config();
        let p = &c.preferred;
        assert_eq!(p.key.first(), Preferred::DEFAULT.key.first());
        assert!(p.key.contains(&Algorithm::Rsa { hash: None }));
        assert_eq!(
            p.kex.first().map(|n| n.as_ref()),
            Preferred::DEFAULT.kex.first().map(|n| n.as_ref())
        );
        assert!(
            p.kex
                .iter()
                .any(|n| n.as_ref() == "diffie-hellman-group14-sha1")
        );
        assert!(p.mac.iter().any(|n| n.as_ref() == "hmac-sha1"));
        assert_eq!(c.keepalive_interval, Some(Duration::from_secs(15)));
        assert_eq!(c.keepalive_max, 3);
        assert_eq!(
            p.mac.first().map(|n| n.as_ref()),
            Preferred::DEFAULT.mac.first().map(|n| n.as_ref())
        );
    }

    #[tokio::test]
    async fn no_credentials_message() {
        let d = tempfile::tempdir().unwrap();
        let known = KnownHosts::new(d.path().join("known_hosts"));
        let creds = Creds {
            password: None,
            key: None,
        };
        let err = Session::connect(&t(), &creds, &known).await.err().unwrap();
        assert_eq!(
            err,
            "no credentials for root@10.0.0.21: pass password_file or key_file"
        );
    }
}
