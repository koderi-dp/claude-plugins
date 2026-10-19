use everything_find::pipeline::Searcher;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // `session-start`: run as the plugin's SessionStart hook instead of the MCP server.
    if std::env::args().nth(1).as_deref() == Some("session-start") {
        if let Some(out) = everything_find::hook::session_start_output(everything_find::sdk::EverythingSdk.status()) {
            println!("{out}");
        }
        return Ok(());
    }
    everything_find::server::run().await
}
