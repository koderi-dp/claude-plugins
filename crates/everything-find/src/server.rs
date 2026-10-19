//! rmcp stdio server exposing the single `find` tool.

use crate::pipeline::{Context, FindParams, run_find};
use crate::sdk::EverythingSdk;
use rmcp::handler::server::{router::tool::ToolRouter, wrapper::Parameters};
use rmcp::model::{Implementation, ServerCapabilities, ServerConfig};
use rmcp::{ErrorData, ServerHandler, ServiceExt, tool, tool_handler, tool_router};

#[derive(Debug, Clone)]
pub struct FindServer {
    tool_router: ToolRouter<Self>,
}

#[tool_router]
impl FindServer {
    pub fn new() -> Self {
        Self { tool_router: Self::tool_router() }
    }

    #[tool(
        description = "Use instead of Glob to find files/folders by name, via the Everything index (Windows). Defaults to the current repo, respecting .gitignore and hiding build output, nested repos and worktrees; scope:\"all\" searches every drive. Query uses Everything syntax (wildcards, ext:, dm:today). Not for content search — use Grep."
    )]
    async fn find(&self, Parameters(params): Parameters<FindParams>) -> Result<String, ErrorData> {
        let outcome = tokio::task::spawn_blocking(move || run_find(&params, &Context::from_env(), &EverythingSdk))
            .await
            .map_err(|e| ErrorData::internal_error(format!("find task failed: {e}"), None))?;
        outcome.map_err(|msg| ErrorData::invalid_params(msg, None))
    }
}

impl Default for FindServer {
    fn default() -> Self {
        Self::new()
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for FindServer {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("everything-find", env!("CARGO_PKG_VERSION")))
            .with_instructions(
                "For finding files or folders by name or pattern, prefer `find` over Glob: it respects .gitignore, hides build output, nested repos and worktrees, and returns compact grouped results. Use Grep for content search.",
            )
    }
}

pub async fn run() -> anyhow::Result<()> {
    let service = FindServer::new().serve(rmcp::transport::stdio()).await?;
    service.waiting().await?;
    Ok(())
}
