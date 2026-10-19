#[tokio::main]
async fn main() -> anyhow::Result<()> {
    everything_find::server::run().await
}
