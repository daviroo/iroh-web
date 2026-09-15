//! Minimal wasm-bindgen bindings around an iroh [`Endpoint`] for browsers.
//!
//! The surface here is deliberately small and low-level. Ergonomics (typed
//! errors, async iterables, option objects) live in the TypeScript package
//! `packages/iroh-web` that wraps this crate.

mod error;
mod streams;

use iroh::{
    Endpoint as IrohEndpoint, EndpointAddr as IrohEndpointAddr, EndpointId, RelayMode, RelayUrl,
    SecretKey,
    endpoint::{Connection as IrohConnection, VarInt, presets},
};
use iroh_tickets::{Ticket, endpoint::EndpointTicket};
use js_sys::{Promise, Uint8Array};
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::future_to_promise;

use crate::error::{Code, bind_error, connect_error, connection_error, js_error};

#[wasm_bindgen(start)]
fn start() {
    console_error_panic_hook::set_once();
}

/// Routes iroh's `tracing` output to the browser console.
///
/// `level` is one of `trace`, `debug`, `info`, `warn`, `error` or `off`.
/// Can only be called once per page load.
#[wasm_bindgen(js_name = initLogging)]
pub fn init_logging(level: &str) -> Result<(), JsValue> {
    use tracing::level_filters::LevelFilter;
    let level: LevelFilter = level
        .parse()
        .map_err(|_| js_error(Code::InvalidArgument, format!("invalid log level: {level}")))?;
    tracing_subscriber::fmt()
        .with_max_level(level)
        .with_writer(
            tracing_subscriber_wasm::MakeConsoleWriter::default()
                .map_trace_level_to(tracing::Level::DEBUG),
        )
        .without_time()
        .with_ansi(false)
        .try_init()
        .map_err(|e| js_error(Code::Internal, format!("logging already initialised: {e}")))
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/// Generates a fresh ed25519 secret key and returns its 32 raw bytes.
#[wasm_bindgen(js_name = generateSecretKey)]
pub fn generate_secret_key() -> Vec<u8> {
    SecretKey::generate().to_bytes().to_vec()
}

/// Returns the endpoint id (hex-encoded public key) for a 32-byte secret key.
#[wasm_bindgen(js_name = secretKeyToId)]
pub fn secret_key_to_id(secret_key: &[u8]) -> Result<String, JsValue> {
    Ok(parse_secret_key(secret_key)?.public().to_string())
}

fn parse_secret_key(bytes: &[u8]) -> Result<SecretKey, JsValue> {
    let bytes: [u8; 32] = bytes.try_into().map_err(|_| {
        js_error(
            Code::InvalidArgument,
            format!("secret key must be 32 bytes, got {}", bytes.len()),
        )
    })?;
    Ok(SecretKey::from_bytes(&bytes))
}

fn parse_endpoint_id(id: &str) -> Result<EndpointId, JsValue> {
    id.parse()
        .map_err(|e| js_error(Code::InvalidArgument, format!("invalid endpoint id: {e}")))
}

// ---------------------------------------------------------------------------
// EndpointAddr
// ---------------------------------------------------------------------------

/// An endpoint id plus the relay URLs it can be reached through.
#[wasm_bindgen]
pub struct EndpointAddr {
    inner: IrohEndpointAddr,
}

#[wasm_bindgen]
impl EndpointAddr {
    /// Builds an address from a hex endpoint id and zero or more relay URLs.
    #[wasm_bindgen(constructor)]
    pub fn new(id: &str, relay_urls: Vec<String>) -> Result<EndpointAddr, JsValue> {
        let mut inner = IrohEndpointAddr::new(parse_endpoint_id(id)?);
        for url in relay_urls {
            inner = inner.with_relay_url(parse_relay_url(&url)?);
        }
        Ok(Self { inner })
    }

    /// Parses an `endpoint…` ticket string (as produced by [`EndpointAddr::to_ticket`]).
    #[wasm_bindgen(js_name = fromTicket)]
    pub fn from_ticket(ticket: &str) -> Result<EndpointAddr, JsValue> {
        let ticket = EndpointTicket::decode_string(ticket.trim())
            .map_err(|e| js_error(Code::InvalidArgument, format!("invalid ticket: {e}")))?;
        Ok(Self {
            inner: ticket.endpoint_addr().clone(),
        })
    }

    /// Serialises this address as a ticket string suitable for QR codes.
    #[wasm_bindgen(js_name = toTicket)]
    pub fn to_ticket(&self) -> String {
        EndpointTicket::new(self.inner.clone()).encode_string()
    }

    /// The hex-encoded endpoint id.
    pub fn id(&self) -> String {
        self.inner.id.to_string()
    }

    /// The relay URLs contained in this address.
    #[wasm_bindgen(js_name = relayUrls)]
    pub fn relay_urls(&self) -> Vec<String> {
        self.inner.relay_urls().map(|u| u.to_string()).collect()
    }
}

fn parse_relay_url(url: &str) -> Result<RelayUrl, JsValue> {
    url.parse()
        .map_err(|e| js_error(Code::InvalidArgument, format!("invalid relay url {url:?}: {e}")))
}

// ---------------------------------------------------------------------------
// Endpoint
// ---------------------------------------------------------------------------

/// A bound iroh endpoint.
///
/// All async operations return promises and internally work on a clone of the
/// iroh endpoint, so any number of them can be in flight at once.
#[wasm_bindgen]
pub struct Endpoint {
    inner: IrohEndpoint,
}

#[wasm_bindgen]
impl Endpoint {
    /// Binds a new endpoint.
    ///
    /// * `secret_key`: 32 raw bytes, or `undefined` to generate one.
    /// * `alpns`: the ALPNs to accept incoming connections for.
    /// * `relay_urls`: relay servers to use. `undefined` selects n0's public
    ///   relays plus pkarr address publishing (the `N0` preset). When given,
    ///   only those relays are used and no address lookup service is configured.
    #[wasm_bindgen(unchecked_return_type = "Promise<Endpoint>")]
    pub fn bind(
        secret_key: Option<Vec<u8>>,
        #[wasm_bindgen(unchecked_param_type = "Uint8Array[]")] alpns: js_sys::Array,
        relay_urls: Option<Vec<String>>,
    ) -> Promise {
        future_to_promise(async move {
            let alpns = alpns
                .iter()
                .map(|v| {
                    v.dyn_into::<Uint8Array>()
                        .map(|a| a.to_vec())
                        .map_err(|_| js_error(Code::InvalidArgument, "alpns must be Uint8Array[]"))
                })
                .collect::<Result<Vec<_>, _>>()?;

            let mut builder = match relay_urls {
                None => IrohEndpoint::builder(presets::N0),
                Some(urls) => {
                    if urls.is_empty() {
                        return Err(js_error(
                            Code::InvalidArgument,
                            "relayUrls must contain at least one relay",
                        ));
                    }
                    let urls = urls
                        .iter()
                        .map(|u| parse_relay_url(u))
                        .collect::<Result<Vec<_>, _>>()?;
                    IrohEndpoint::builder(presets::Minimal).relay_mode(RelayMode::custom(urls))
                }
            };
            if let Some(bytes) = secret_key {
                builder = builder.secret_key(parse_secret_key(&bytes)?);
            }
            let inner = builder.alpns(alpns).bind().await.map_err(bind_error)?;
            Ok(Endpoint { inner }.into())
        })
    }

    /// The hex-encoded endpoint id.
    pub fn id(&self) -> String {
        self.inner.id().to_string()
    }

    /// The current address (id plus known relay URLs). Call `online()` first
    /// to make sure a relay URL is included.
    pub fn addr(&self) -> EndpointAddr {
        EndpointAddr {
            inner: self.inner.addr(),
        }
    }

    /// Resolves once the endpoint has a working connection to a home relay.
    #[wasm_bindgen(unchecked_return_type = "Promise<void>")]
    pub fn online(&self) -> Promise {
        let ep = self.inner.clone();
        future_to_promise(async move {
            ep.online().await;
            Ok(JsValue::UNDEFINED)
        })
    }

    /// Connects to a remote endpoint with the given ALPN.
    #[wasm_bindgen(unchecked_return_type = "Promise<Connection>")]
    pub fn connect(&self, addr: &EndpointAddr, alpn: &[u8]) -> Promise {
        let ep = self.inner.clone();
        let addr = addr.inner.clone();
        let alpn = alpn.to_vec();
        future_to_promise(async move {
            let conn = ep.connect(addr, &alpn).await.map_err(connect_error)?;
            Ok(Connection { inner: conn }.into())
        })
    }

    /// Waits for the next incoming connection.
    ///
    /// Resolves with `undefined` once the endpoint is closed. Incoming
    /// connections whose handshake fails are logged and skipped.
    #[wasm_bindgen(unchecked_return_type = "Promise<Connection | undefined>")]
    pub fn accept(&self) -> Promise {
        let ep = self.inner.clone();
        future_to_promise(async move {
            loop {
                let Some(incoming) = ep.accept().await else {
                    return Ok(JsValue::UNDEFINED);
                };
                match incoming.await {
                    Ok(conn) => return Ok(Connection { inner: conn }.into()),
                    Err(err) => tracing::warn!("incoming connection failed: {err:#}"),
                }
            }
        })
    }

    /// Closes the endpoint and all its connections.
    #[wasm_bindgen(unchecked_return_type = "Promise<void>")]
    pub fn close(&self) -> Promise {
        let ep = self.inner.clone();
        future_to_promise(async move {
            ep.close().await;
            Ok(JsValue::UNDEFINED)
        })
    }

    /// Whether `close()` has been called.
    #[wasm_bindgen(js_name = isClosed)]
    pub fn is_closed(&self) -> bool {
        self.inner.is_closed()
    }
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

/// An established QUIC connection to a remote endpoint.
#[wasm_bindgen]
pub struct Connection {
    inner: IrohConnection,
}

#[wasm_bindgen]
impl Connection {
    /// Hex-encoded id of the remote endpoint.
    #[wasm_bindgen(js_name = remoteId)]
    pub fn remote_id(&self) -> String {
        self.inner.remote_id().to_string()
    }

    /// The ALPN negotiated for this connection.
    pub fn alpn(&self) -> Vec<u8> {
        self.inner.alpn().to_vec()
    }

    /// Opens a bidirectional stream. Resolves with `[WritableStream, ReadableStream]`.
    #[wasm_bindgen(
        js_name = openBi,
        unchecked_return_type = "Promise<[WritableStream<Uint8Array>, ReadableStream<Uint8Array>]>"
    )]
    pub fn open_bi(&self) -> Promise {
        let conn = self.inner.clone();
        future_to_promise(async move {
            let (send, recv) = conn.open_bi().await.map_err(|e| connection_error(&e))?;
            Ok(streams::bi_pair(send, recv))
        })
    }

    /// Accepts the next bidirectional stream opened by the remote.
    #[wasm_bindgen(
        js_name = acceptBi,
        unchecked_return_type = "Promise<[WritableStream<Uint8Array>, ReadableStream<Uint8Array>]>"
    )]
    pub fn accept_bi(&self) -> Promise {
        let conn = self.inner.clone();
        future_to_promise(async move {
            let (send, recv) = conn.accept_bi().await.map_err(|e| connection_error(&e))?;
            Ok(streams::bi_pair(send, recv))
        })
    }

    /// Opens a unidirectional (send-only) stream.
    #[wasm_bindgen(
        js_name = openUni,
        unchecked_return_type = "Promise<WritableStream<Uint8Array>>"
    )]
    pub fn open_uni(&self) -> Promise {
        let conn = self.inner.clone();
        future_to_promise(async move {
            let send = conn.open_uni().await.map_err(|e| connection_error(&e))?;
            Ok(streams::writable(send))
        })
    }

    /// Accepts the next unidirectional (receive-only) stream opened by the remote.
    #[wasm_bindgen(
        js_name = acceptUni,
        unchecked_return_type = "Promise<ReadableStream<Uint8Array>>"
    )]
    pub fn accept_uni(&self) -> Promise {
        let conn = self.inner.clone();
        future_to_promise(async move {
            let recv = conn.accept_uni().await.map_err(|e| connection_error(&e))?;
            Ok(streams::readable(recv))
        })
    }

    /// Closes the connection immediately with an application error code and reason.
    pub fn close(&self, error_code: u32, reason: &[u8]) {
        self.inner.close(VarInt::from(error_code), reason);
    }

    /// Resolves with an `Error` (carrying a `code` property) describing why the
    /// connection closed, once it has closed.
    #[wasm_bindgen(unchecked_return_type = "Promise<Error>")]
    pub fn closed(&self) -> Promise {
        let conn = self.inner.clone();
        future_to_promise(async move {
            let reason = conn.closed().await;
            Ok(connection_error(&reason))
        })
    }
}
