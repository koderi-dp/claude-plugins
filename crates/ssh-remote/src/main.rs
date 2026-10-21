#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // `session-start`: run as the plugin's SessionStart hook instead of the MCP server.
    if std::env::args().nth(1).as_deref() == Some("session-start") {
        println!("{}", ssh_remote::hook::session_start_output());
        return Ok(());
    }
    ssh_remote::server::run().await
}
