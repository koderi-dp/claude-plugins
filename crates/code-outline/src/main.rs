#[tokio::main]
async fn main() -> anyhow::Result<()> {
    code_outline::server::run().await
}
