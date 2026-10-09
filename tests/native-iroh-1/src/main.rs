use std::{io::Write, time::Duration};

use anyhow::{Context, Result};
use iroh::{
    Endpoint, RelayMode, RelayUrl,
    endpoint::{Connection, presets},
};
use iroh_tickets::endpoint::EndpointTicket;
use serde::Deserialize;
use serde_json::json;
use tokio::io::{AsyncBufReadExt, BufReader};

const ALPN: &[u8] = b"iroh-web/test-echo/0";
const LIMIT: usize = 4 * 1024 * 1024;

#[derive(Deserialize)]
struct Dial {
    ticket: String,
    payload: Vec<u8>,
}

fn emit(value: serde_json::Value) -> Result<()> {
    println!("{value}");
    std::io::stdout().flush()?;
    Ok(())
}

async fn echo(conn: Connection) -> Result<()> {
    let (mut send, mut recv) = conn.accept_bi().await.context("accept bi stream")?;
    let bytes = recv
        .read_to_end(LIMIT)
        .await
        .context("read request through FIN")?;
    send.write_all(&bytes).await.context("write echo")?;
    send.finish().context("echo FIN")?;
    conn.closed().await;
    Ok(())
}

async fn dial(ep: &Endpoint, request: Dial) -> Result<serde_json::Value> {
    let ticket: EndpointTicket = request.ticket.parse().context("parse browser ticket")?;
    let conn = ep
        .connect(ticket.endpoint_addr().clone(), ALPN)
        .await
        .context("dial browser handshake")?;
    let (mut send, mut recv) = conn.open_bi().await.context("open bi stream")?;
    send.write_all(&request.payload)
        .await
        .context("write request")?;
    send.finish().context("request FIN")?;
    let echoed = recv
        .read_to_end(LIMIT)
        .await
        .context("read echo through FIN")?;
    let remote_id = conn.remote_id().to_string();
    conn.close(0u32.into(), b"done");
    Ok(json!({"echoed": echoed, "remoteId": remote_id}))
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .with_writer(std::io::stderr)
        .init();
    let url: RelayUrl = std::env::args()
        .nth(1)
        .context("relay URL required")?
        .parse()?;
    let ep = Endpoint::builder(presets::Minimal)
        .clear_ip_transports()
        .relay_mode(RelayMode::custom([url]))
        .alpns(vec![ALPN.to_vec()])
        .bind()
        .await
        .context("bind iroh 1.0 endpoint")?;
    tokio::time::timeout(Duration::from_secs(20), ep.online())
        .await
        .context("iroh 1.0 relay registration timed out")?;
    emit(json!({"ticket": EndpointTicket::new(ep.addr()).to_string(), "id": ep.id().to_string()}))?;
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    loop {
        tokio::select! {
            incoming = ep.accept() => {
                let Some(incoming) = incoming else { break };
                tokio::spawn(async move {
                    let result = async {
                        let conn = incoming.await.context("accept browser handshake")?;
                        echo(conn).await
                    }.await;
                    if let Err(err) = result { eprintln!("[iroh 1.0] {err:#}"); }
                });
            }
            line = lines.next_line() => {
                let Some(line) = line? else { break };
                let request: Dial = serde_json::from_str(&line)?;
                let result = tokio::time::timeout(Duration::from_secs(30), dial(&ep, request)).await;
                emit(match result {
                    Ok(Ok(value)) => value,
                    Ok(Err(err)) => json!({"error": format!("{err:#}")}),
                    Err(err) => json!({"error": format!("native dial/echo timed out: {err}")}),
                })?;
            }
        }
    }
    ep.close().await;
    Ok(())
}
