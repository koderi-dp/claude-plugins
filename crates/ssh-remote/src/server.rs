//! rmcp stdio server exposing the `ssh` and `ssh_download` tools.
//!
//! Every failure is a tool error (`isError: true`) with a one-line message. Before any text goes
//! back to the client it is masked with the secrets known for that call: the pool hands them to
//! the call and masks its own errors; errors raised before the pool is reached (parameter checks,
//! unreadable credential files) never contain secret text.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use rmcp::handler::server::{router::tool::ToolRouter, wrapper::Parameters};
use rmcp::model::{CallToolResult, ContentBlock, Implementation, ServerCapabilities, ServerConfig};
use rmcp::{ErrorData, ServerHandler, ServiceExt, tool, tool_handler, tool_router};

use crate::format::{render_download, render_exec};
use crate::hook::SESSION_HINT;
use crate::known_hosts::KnownHosts;
use crate::params::{DownloadParams, SshParams};
use crate::pool::Pool;
use crate::secret::{Secret, mask_all};
use crate::transfer::{default_local_path, download, host_dir};

/// Idle sessions close after this long.
pub const IDLE: Duration = Duration::from_secs(5 * 60);
/// Largest file `ssh_download` fetches.
pub const DOWNLOAD_CAP: u64 = 200 * 1024 * 1024;
/// Longest `ssh_download` may take, connect excluded.
pub const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(600);

#[derive(Clone)]
pub struct SshServer {
    pool: Arc<Pool>,
    tool_router: ToolRouter<Self>,
}

/// Masks `text` with `secrets` and wraps it as a successful tool result.
fn ok(secrets: &[&Secret], text: &str) -> CallToolResult {
    CallToolResult::success(vec![ContentBlock::text(mask_all(secrets, text))])
}

/// Masks `msg` with `secrets` and wraps it as a tool error.
fn fail(secrets: &[&Secret], msg: &str) -> CallToolResult {
    CallToolResult::error(vec![ContentBlock::text(mask_all(secrets, msg))])
}

#[tool_router]
impl SshServer {
    pub fn new(known: KnownHosts) -> Self {
        Self {
            pool: Arc::new(Pool::new(known, IDLE)),
            tool_router: Self::tool_router(),
        }
    }

    #[tool(
        description = "Run a command on a remote host over SSH. Pass credentials as file paths (password_file or key_file); the plugin reads them, so never read or print those files."
    )]
    async fn ssh(
        &self,
        Parameters(params): Parameters<SshParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let files = params.cred_files();
        let checked = params
            .timeout_s()
            .and_then(|t| Ok((t, params.max_lines()?)));
        let (timeout_s, max_lines) = match checked {
            Ok(v) => v,
            Err(e) => return Ok(fail(&[], &e)),
        };
        let creds = match files.load() {
            Ok(c) => c,
            Err(e) => return Ok(fail(&[], &e)),
        };
        let target = params.target();
        let full_dir = host_dir(&target.host);
        let command = params.command.as_str();
        let result = self
            .pool
            .with_session(&target, creds, async |s, secrets| {
                let outcome = s.exec(command, Duration::from_secs(timeout_s)).await?;
                Ok(ok(
                    secrets,
                    &render_exec(&outcome, max_lines, secrets, &full_dir),
                ))
            })
            .await;
        Ok(result.unwrap_or_else(|e| fail(&[], &e)))
    }

    #[tool(
        description = "Download a file from a remote host over SSH (SFTP), up to 200 MB, giving up after 600 s. Saves to local_path, overwriting an existing file there, or by default to %TEMP%\\ssh-remote\\<host>\\<file name>. Pass credentials as file paths (password_file or key_file); the plugin reads them, so never read or print those files."
    )]
    async fn ssh_download(
        &self,
        Parameters(params): Parameters<DownloadParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let files = params.cred_files();
        let creds = match files.load() {
            Ok(c) => c,
            Err(e) => return Ok(fail(&[], &e)),
        };
        let target = params.target();
        let remote = params.remote_path.as_str();
        let local = params
            .local_path
            .as_deref()
            .map(PathBuf::from)
            .unwrap_or_else(|| default_local_path(&target.host, remote));
        let host = target.host.as_str();
        let result = self
            .pool
            .with_session(&target, creds, async |s, secrets| {
                let started = Instant::now();
                let bytes = download(s, remote, &local, DOWNLOAD_CAP, DOWNLOAD_TIMEOUT).await?;
                let text = render_download(
                    host,
                    remote,
                    &local,
                    bytes,
                    started.elapsed(),
                    &s.key_status,
                );
                Ok(ok(secrets, &text))
            })
            .await;
        Ok(result.unwrap_or_else(|e| fail(&[], &e)))
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for SshServer {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("ssh-remote", env!("CARGO_PKG_VERSION")))
            .with_instructions(SESSION_HINT)
    }
}

pub async fn run() -> anyhow::Result<()> {
    let server = SshServer::new(KnownHosts::new(KnownHosts::default_path()));
    let service = server.serve(rmcp::transport::stdio()).await?;
    service.waiting().await?;
    Ok(())
}
