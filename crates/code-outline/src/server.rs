//! rmcp stdio server exposing the `outline` and `read_symbol` tools.

use crate::files::Context;
use crate::pipeline::{OutlineParams, ReadSymbolParams, run_outline, run_read_symbol};
use rmcp::handler::server::{router::tool::ToolRouter, wrapper::Parameters};
use rmcp::model::{Implementation, ServerCapabilities, ServerConfig};
use rmcp::{ErrorData, ServerHandler, ServiceExt, tool, tool_handler, tool_router};

#[derive(Debug, Clone)]
pub struct OutlineServer {
    tool_router: ToolRouter<Self>,
}

fn into_tool_result(
    joined: Result<Result<String, String>, tokio::task::JoinError>,
    tool: &str,
) -> Result<String, ErrorData> {
    joined
        .map_err(|e| ErrorData::internal_error(format!("{tool} task failed: {e}"), None))?
        .map_err(|msg| ErrorData::invalid_params(msg, None))
}

#[tool_router]
impl OutlineServer {
    pub fn new() -> Self {
        Self {
            tool_router: Self::tool_router(),
        }
    }

    #[tool(
        description = "List the symbols (functions, classes, methods…) in source files with line ranges, without reading the bodies. Rust, TS/JS, Python, C#. Use before Read to find what you need, then read_symbol."
    )]
    async fn outline(
        &self,
        Parameters(params): Parameters<OutlineParams>,
    ) -> Result<String, ErrorData> {
        let joined =
            tokio::task::spawn_blocking(move || run_outline(&params, &Context::from_env())).await;
        into_tool_result(joined, "outline")
    }

    #[tool(
        description = "Read one symbol's source (with its doc comments and attributes) from a file, line-numbered like Read. symbol is a name or qualified path: ApiClient.get, FindServer::find."
    )]
    async fn read_symbol(
        &self,
        Parameters(params): Parameters<ReadSymbolParams>,
    ) -> Result<String, ErrorData> {
        let joined =
            tokio::task::spawn_blocking(move || run_read_symbol(&params, &Context::from_env()))
                .await;
        into_tool_result(joined, "read_symbol")
    }
}

impl Default for OutlineServer {
    fn default() -> Self {
        Self::new()
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for OutlineServer {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build()).with_server_info(
            Implementation::new("code-outline", env!("CARGO_PKG_VERSION")),
        )
    }
}

pub async fn run() -> anyhow::Result<()> {
    let service = OutlineServer::new().serve(rmcp::transport::stdio()).await?;
    service.waiting().await?;
    Ok(())
}
