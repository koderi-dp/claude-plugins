//! Tool parameters and their checks. No parameter carries a secret: credentials are file paths.

use std::path::PathBuf;

use schemars::JsonSchema;
use serde::Deserialize;

use crate::secret::Secret;
use crate::session::{Creds, Target};

pub const DEFAULT_PORT: u16 = 22;
pub const DEFAULT_TIMEOUT_S: u64 = 60;
pub const DEFAULT_MAX_LINES: usize = 200;

#[derive(Deserialize, JsonSchema)]
pub struct SshParams {
    /// Host name or IP address.
    pub host: String,
    /// User to log in as.
    pub user: String,
    /// Shell command to run on the host.
    pub command: String,
    /// SSH port. Default 22.
    pub port: Option<u16>,
    /// Path of a local file holding only the password. Never read or print it.
    pub password_file: Option<String>,
    /// Path of a local private key file (OpenSSH format). Tried before the password.
    pub key_file: Option<String>,
    /// Path of a local file holding the key's passphrase, for an encrypted key_file.
    pub key_passphrase_file: Option<String>,
    /// Seconds to wait for the command, 1-600. Default 60.
    pub timeout_s: Option<u64>,
    /// Output lines to show per stream (first and last half), at least 1. Default 200. The full
    /// output is saved to a file when trimmed.
    pub max_lines: Option<usize>,
}

#[derive(Deserialize, JsonSchema)]
pub struct DownloadParams {
    /// Host name or IP address.
    pub host: String,
    /// User to log in as.
    pub user: String,
    /// SSH port. Default 22.
    pub port: Option<u16>,
    /// Path of a local file holding only the password. Never read or print it.
    pub password_file: Option<String>,
    /// Path of a local private key file (OpenSSH format). Tried before the password.
    pub key_file: Option<String>,
    /// Path of a local file holding the key's passphrase, for an encrypted key_file.
    pub key_passphrase_file: Option<String>,
    /// Absolute path of the file on the remote host.
    pub remote_path: String,
    /// Local destination; an existing file there is overwritten. Default
    /// %TEMP%\ssh-remote\<host>\<remote file name>.
    pub local_path: Option<String>,
}

/// The credential paths shared by both tools.
pub struct CredFiles<'a> {
    pub password_file: Option<&'a str>,
    pub key_file: Option<&'a str>,
    pub key_passphrase_file: Option<&'a str>,
}

impl SshParams {
    pub fn target(&self) -> Target {
        target(&self.host, &self.user, self.port)
    }

    pub fn cred_files(&self) -> CredFiles<'_> {
        CredFiles {
            password_file: self.password_file.as_deref(),
            key_file: self.key_file.as_deref(),
            key_passphrase_file: self.key_passphrase_file.as_deref(),
        }
    }

    /// The timeout in seconds, checked against 1-600.
    pub fn timeout_s(&self) -> Result<u64, String> {
        let t = self.timeout_s.unwrap_or(DEFAULT_TIMEOUT_S);
        if (1..=600).contains(&t) {
            Ok(t)
        } else {
            Err("timeout_s must be 1-600".into())
        }
    }

    pub fn max_lines(&self) -> Result<usize, String> {
        match self.max_lines.unwrap_or(DEFAULT_MAX_LINES) {
            0 => Err("max_lines must be at least 1".into()),
            n => Ok(n),
        }
    }
}

impl DownloadParams {
    pub fn target(&self) -> Target {
        target(&self.host, &self.user, self.port)
    }

    pub fn cred_files(&self) -> CredFiles<'_> {
        CredFiles {
            password_file: self.password_file.as_deref(),
            key_file: self.key_file.as_deref(),
            key_passphrase_file: self.key_passphrase_file.as_deref(),
        }
    }
}

fn target(host: &str, user: &str, port: Option<u16>) -> Target {
    Target {
        host: host.to_string(),
        port: port.unwrap_or(DEFAULT_PORT),
        user: user.to_string(),
    }
}

impl CredFiles<'_> {
    /// Checks the combination without touching any file.
    pub fn check(&self) -> Result<(), String> {
        if self.key_passphrase_file.is_some() && self.key_file.is_none() {
            return Err("key_passphrase_file needs key_file".into());
        }
        Ok(())
    }

    /// Reads the credential files. `None` when neither password_file nor key_file is given, so
    /// the pool reuses an open session (or reports the missing credentials).
    pub fn load(&self) -> Result<Option<Creds>, String> {
        self.check()?;
        if self.password_file.is_none() && self.key_file.is_none() {
            return Ok(None);
        }
        let password = self
            .password_file
            .map(|p| Secret::from_file(p.as_ref()))
            .transpose()?;
        let key = match self.key_file {
            Some(k) => {
                let pass = self
                    .key_passphrase_file
                    .map(|p| Secret::from_file(p.as_ref()))
                    .transpose()?;
                Some((PathBuf::from(k), pass))
            }
            None => None,
        };
        Ok(Some(Creds { password, key }))
    }

    /// Re-reads the secret files for masking only, skipping any that cannot be read. Used for
    /// errors raised before the pool hands its secrets to the call (e.g. a failed connect).
    pub fn mask_secrets(&self) -> Vec<Secret> {
        [self.password_file, self.key_passphrase_file]
            .into_iter()
            .flatten()
            .filter_map(|p| Secret::from_file(p.as_ref()).ok())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ssh(timeout_s: Option<u64>, max_lines: Option<usize>) -> SshParams {
        SshParams {
            host: "h".into(),
            user: "u".into(),
            command: "true".into(),
            port: None,
            password_file: None,
            key_file: None,
            key_passphrase_file: None,
            timeout_s,
            max_lines,
        }
    }

    #[test]
    fn defaults() {
        let p = ssh(None, None);
        assert_eq!(p.timeout_s().unwrap(), 60);
        assert_eq!(p.max_lines().unwrap(), 200);
        assert_eq!(p.target().port, 22);
    }

    #[test]
    fn timeout_bounds() {
        assert_eq!(ssh(Some(1), None).timeout_s().unwrap(), 1);
        assert_eq!(ssh(Some(600), None).timeout_s().unwrap(), 600);
        assert!(ssh(Some(0), None).timeout_s().is_err());
        assert!(ssh(Some(601), None).timeout_s().is_err());
    }

    #[test]
    fn no_files_means_no_creds() {
        assert!(ssh(None, None).cred_files().load().unwrap().is_none());
    }

    #[test]
    fn passphrase_without_key() {
        let mut p = ssh(None, None);
        p.key_passphrase_file = Some("x".into());
        assert_eq!(
            p.cred_files().load().err().unwrap(),
            "key_passphrase_file needs key_file"
        );
    }

    #[test]
    fn loads_password_and_key() {
        let d = tempfile::tempdir().unwrap();
        let pw = d.path().join("pw.txt");
        std::fs::write(&pw, "secret\n").unwrap();
        let mut p = ssh(None, None);
        p.password_file = Some(pw.to_str().unwrap().into());
        p.key_file = Some("C:\\keys\\id".into());
        let creds = p.cred_files().load().unwrap().unwrap();
        assert_eq!(creds.password.unwrap().expose(), "secret");
        let (k, pass) = creds.key.unwrap();
        assert_eq!(k, PathBuf::from("C:\\keys\\id"));
        assert!(pass.is_none());
    }
}
