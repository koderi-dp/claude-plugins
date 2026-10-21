//! One authenticated SSH connection: connect with auto-trusted host keys, authenticate with a
//! key and/or password read from files, and run commands with a timeout.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use russh::client::{self, AuthResult};
use russh::keys::{self, Algorithm, HashAlg, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use russh::{ChannelMsg, Preferred, kex, mac};

use crate::format::ExecOutcome;
use crate::known_hosts::{HostKeyStatus, KnownHosts};
use crate::secret::Secret;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

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
        let status = self
            .known
            .check_and_record(&self.host, self.port, &fingerprint)
            .map_err(|e| {
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
        ..Default::default()
    }
}

fn auth_failed(t: &Target, key: Option<&Path>, password: Option<&Path>) -> String {
    let parts = match (key, password) {
        (Some(k), Some(p)) => {
            format!("tried key {}, password from {}", k.display(), p.display())
        }
        (Some(k), None) => format!("tried key {}", k.display()),
        (None, Some(p)) => format!("password from {}", p.display()),
        (None, None) => "no credentials".to_string(),
    };
    format!("auth failed for {}@{}:{} ({parts})", t.user, t.host, t.port)
}

fn key_load_error(path: &Path, passphrase: Option<&Secret>, e: keys::Error) -> String {
    let shown = path.display();
    match (e, passphrase) {
        (keys::Error::KeyIsEncrypted, None) => {
            format!("key {shown} is encrypted: pass key_passphrase_file")
        }
        (keys::Error::IO(e), _) if e.kind() == std::io::ErrorKind::NotFound => {
            format!("key {shown}: not found")
        }
        (keys::Error::IO(e), _) => format!("key {shown}: cannot read ({})", e.kind()),
        (_, Some(p)) => format!(
            "key {shown}: cannot load with the passphrase from {} (wrong passphrase or unsupported key)",
            p.source().display()
        ),
        (e, None) => format!("key {shown}: cannot load ({e})"),
    }
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
        // Load the key before touching the network: a bad key file is the caller's to fix.
        let key = match &creds.key {
            Some((path, passphrase)) => {
                let pass = passphrase.as_ref();
                let k = keys::load_secret_key(path, pass.map(Secret::expose))
                    .map_err(|e| key_load_error(path, pass, e))?;
                Some((path.as_path(), k))
            }
            None => None,
        };

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
            if let Some(pw) = &creds.password
                && let AuthResult::Success = handle
                    .authenticate_password(&t.user, pw.expose())
                    .await
                    .map_err(transport)?
            {
                return Ok(());
            }
            Err(auth_failed(
                t,
                key.as_ref().map(|(p, _)| *p),
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

    /// Runs `command`, collecting stdout, stderr and the exit status. On timeout the channel is
    /// closed and the partial output returned with `timed_out` set; the session stays usable.
    pub async fn exec(&self, command: &str, timeout: Duration) -> Result<ExecOutcome, String> {
        let started = Instant::now();
        let fail =
            |what: &str, e: russh::Error| format!("{what} on {}@{}: {e}", self.user, self.host);
        let mut channel = self
            .handle
            .channel_open_session()
            .await
            .map_err(|e| fail("cannot open a channel", e))?;
        channel
            .exec(true, command)
            .await
            .map_err(|e| fail("cannot run the command", e))?;

        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let mut exit = None;
        let read = async {
            // The exit status usually arrives after Eof, so read until Close.
            while let Some(msg) = channel.wait().await {
                match msg {
                    ChannelMsg::Data { data } => stdout.extend_from_slice(&data),
                    ChannelMsg::ExtendedData { data, ext: 1 } => stderr.extend_from_slice(&data),
                    ChannelMsg::ExitStatus { exit_status } => exit = Some(exit_status),
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
        let timed_out = match tokio::time::timeout(timeout, read).await {
            Ok(r) => {
                r?;
                None
            }
            Err(_) => Some(timeout.as_secs()),
        };
        if timed_out.is_some() {
            let _ = channel.close().await;
        }

        Ok(ExecOutcome {
            user: self.user.clone(),
            host: self.host.clone(),
            exit,
            elapsed: started.elapsed(),
            stdout,
            stderr,
            timed_out,
            key_status: self.key_status.clone(),
        })
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
        assert_eq!(
            auth_failed(&t(), Some(k), Some(p)),
            r"auth failed for root@10.0.0.21:22 (tried key C:\keys\id_ed25519, password from C:\temp\pw.txt)"
        );
        assert_eq!(
            auth_failed(&t(), Some(k), None),
            r"auth failed for root@10.0.0.21:22 (tried key C:\keys\id_ed25519)"
        );
        assert_eq!(
            auth_failed(&t(), None, Some(p)),
            r"auth failed for root@10.0.0.21:22 (password from C:\temp\pw.txt)"
        );
    }

    #[test]
    fn encrypted_key_without_passphrase_message() {
        let msg = key_load_error(Path::new(r"C:\k\id_rsa"), None, keys::Error::KeyIsEncrypted);
        assert_eq!(
            msg,
            r"key C:\k\id_rsa is encrypted: pass key_passphrase_file"
        );
    }

    #[test]
    fn missing_key_file_message() {
        let e = keys::Error::IO(std::io::Error::from(std::io::ErrorKind::NotFound));
        assert_eq!(
            key_load_error(Path::new(r"C:\k\nope"), None, e),
            r"key C:\k\nope: not found"
        );
    }

    #[test]
    fn wrong_passphrase_names_passphrase_file_not_contents() {
        let d = tempfile::tempdir().unwrap();
        let pf = d.path().join("pass.txt");
        std::fs::write(&pf, "hunter2-passphrase").unwrap();
        let pass = Secret::from_file(&pf).unwrap();
        let msg = key_load_error(
            Path::new(r"C:\k\id"),
            Some(&pass),
            keys::Error::CouldNotReadKey,
        );
        assert!(msg.contains(&pf.display().to_string()), "{msg}");
        assert!(!msg.contains("hunter2"), "{msg}");
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
