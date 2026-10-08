# iroh-web

An [iroh](https://iroh.computer) endpoint that runs in the browser. Rust compiled to
WebAssembly with `wasm-bindgen`, plus a thin TypeScript API on top, packaged for npm.

It is protocol-agnostic: you get an `Endpoint`, `Connection`s and QUIC streams as
WHATWG `ReadableStream` / `WritableStream`, and build your own ALPN protocol on top.

Status: working first version (v0.1).

## Install

```sh
pnpm add @daviroo/iroh-web
```

Consumers need a bundler that understands ES-module wasm imports. With Vite, use
[`vite-plugin-wasm`](https://github.com/Menci/vite-plugin-wasm) and
`build.target: 'esnext'` (or `vite-plugin-top-level-await`). See
`examples/echo/vite.config.ts`.

For optional features, load the package from a lazy module:

```ts
// In a module that the app itself loads with import().
const { Endpoint, readAll, writeAll } = await import('@daviroo/iroh-web')
```

Set `optimizeDeps.exclude: ['@daviroo/iroh-web']` in Vite. The package's static
ESM wasm import stays behind that dynamic boundary: Vite emits a separate wasm
asset and lazy JavaScript chunks. `pnpm test` builds a minimal consumer and checks
in Chromium that no wasm is fetched initially, then binds an endpoint after a click.

## Limits you should know about

- **Relay-only.** Browsers cannot open UDP sockets, so the endpoint talks to an iroh
  relay server over WebSocket and every connection is relayed. There is no hole
  punching and no direct path, even between two machines on the same LAN.
- **Secure context required.** The page must be served over `https://` or from
  `localhost`. Browsers also block `ws://` relays from an `https://` page, so a
  production relay must be reachable over `https://`.
- **Self-host a relay for production.** By default the endpoint uses n0's public relays
  and pkarr address publishing. Those are rate-limited and intended for development
  only. Run your own [`iroh-relay`](https://github.com/n0-computer/iroh/tree/main/iroh-relay)
  and pass its URL in `relayUrls`.
- **Ticket, not bare id.** When you pass `relayUrls`, no address lookup service is
  configured, so peers must be dialled with a ticket (or an `EndpointAddr`) that
  carries their relay URL. Dialling a bare endpoint id only works with the n0 default.
- **Connect deadline.** Ticket-based dialing to an unreachable relay rejects with
  `IrohError` code `timed_out` after approximately 30 seconds in the tested iroh 1.2
  build. There is no `timeoutMs` option; this is the transport's timeout, not a
  configurable application deadline. `online()` has no deadline and is not needed
  before dialing a ticket (it is needed before advertising your own relay address).
- **Left out of v0.1:** datagrams, watchers (relay status, net report), remote peer
  info, runtime relay add/remove, custom address lookup and transports, metrics,
  iroh-gossip, iroh-blobs.

## Repository layout

| Path | What |
|------|------|
| `crates/iroh-web-wasm/` | Rust crate: minimal, low-level `wasm-bindgen` exports around `iroh::Endpoint` |
| `packages/iroh-web/` | The npm package: TypeScript wrapper (`src/`) plus the `wasm-pack` output (`pkg/`, generated) |
| `tests/` | Chromium tests against Node iroh 1.1 and an isolated Rust iroh 1.0 peer, plus a lazy Vite build/runtime check |
| `examples/echo/` | Minimal Vite page: bind an endpoint, show a ticket, dial another tab and get an echo |

The design rule is: keep the `wasm-bindgen` surface small and stable, and put the
ergonomics (option objects, typed errors, async iteration) in TypeScript, which is
much cheaper to change than the glue.

## Toolchain

Build tools (macOS, Apple Silicon paths shown):

| Tool | Why | Install |
|------|-----|---------|
| Rust stable with the `wasm32-unknown-unknown` target | compile the crate | `rustup target add wasm32-unknown-unknown` |
| Homebrew LLVM | `ring` has C sources that Apple's clang cannot compile for wasm32 | `brew install llvm` |
| `wasm-pack` 0.15 | runs cargo + `wasm-bindgen-cli` (downloaded or built on first use to match the pinned `wasm-bindgen` version) | `brew install wasm-pack` |
| `binaryen` (`wasm-opt`) | shrinks the `.wasm` | `brew install binaryen` |
| Node 20.3+ and pnpm | TypeScript build, tests | |
| `iroh-relay` | local relay for the tests and example | binary from the [iroh releases](https://github.com/n0-computer/iroh/releases) (tested with v1.2.0), or `cargo install iroh-relay --version 1.2.0` |

The wasm build script selects Homebrew LLVM from `/opt/homebrew/opt/llvm/bin`
when available, so no global PATH change is needed. On Linux, install clang and
LLVM. Override the compiler with `CC_wasm32_unknown_unknown` and
`AR_wasm32_unknown_unknown` on other setups. For direct Cargo commands on macOS,
set those variables to the Homebrew `clang` and `llvm-ar` paths.

## Build

```sh
pnpm install
pnpm build            # wasm-pack --release --target bundler, then wasm-opt -Oz, then tsc
pnpm build:wasm       # only the wasm step
pnpm --filter @daviroo/iroh-web build:wasm:dev   # fast unoptimised wasm for development
pnpm typecheck
```

The wasm step writes `packages/iroh-web/pkg/` in the standard
wasm-pack bundler-target layout (`.d.ts` included):

```
pkg/iroh_web_wasm.js         # re-exports, imports the .wasm as an ES module
pkg/iroh_web_wasm_bg.js      # glue
pkg/iroh_web_wasm_bg.wasm
pkg/iroh_web_wasm.d.ts
```

Release size of `iroh_web_wasm_bg.wasm` (iroh 1.2.0, `opt-level = "z"`, LTO, `wasm-opt -Oz`):

| | Size |
|---|---|
| raw | 2470 KiB |
| gzip -9 | 1050 KiB |

Consumers need a bundler that understands ES-module wasm imports. With Vite that is
[`vite-plugin-wasm`](https://github.com/Menci/vite-plugin-wasm) plus
`build.target: 'esnext'` (or `vite-plugin-top-level-await`), exactly as in
`examples/echo/vite.config.ts`.

## Test

```sh
pnpm test
```

If invoking Vitest directly, first build the native peer from the repository root:
`cargo build --locked --manifest-path tests/native-iroh-1/Cargo.toml`.

`pnpm test` first builds `tests/native-iroh-1/` with its own locked Cargo workspace
(`iroh = "=1.0.0"`, relay/base locked to 1.0.0; the wasm lockfile is untouched).
It starts `iroh-relay --dev` on port 3340 (plain HTTP, no TLS), launches headless
Chromium through Playwright, binds endpoints in the page, the Vitest Node process
using `@number0/iroh` 1.1, and the Rust 1.0 process, and checks:

- ticket round trip in the browser, and that `@number0/iroh` parses the same ticket
- secret key generate, import and export
- browser dials Node and gets its bytes echoed back (small and 256 KiB payloads)
- Node dials the browser and gets its bytes echoed back
- a remote `close(42, "bye")` arrives as `application_closed` with `errorCode` and `reason`
- dialling an unknown id with custom relays fails with `no_address`
- dialling with an ALPN the peer does not accept fails with `connection_closed`
- browser 1.2 dials a Rust 1.0 ticket, sends 256 KiB + FIN and reads echo through FIN
- Rust 1.0 dials a browser ticket, sends bytes + FIN and reads echo through FIN;
  native IP transports are disabled so neither direction can bypass the relay
- an unreachable relay rejects with `timed_out` within 45 seconds
- a production Vite build emits separate lazy JS/wasm files and only fetches wasm
  when the lazy feature is invoked (the check prints the `tests/build/dist/` chunks)

The 1.0/1.2 echo interop checks exercise one bidirectional stream per request,
with FIN delimiting both the request and response. They verify transport
compatibility, not application-specific protocols or codecs.

Run `pnpm exec playwright install chromium` in `tests/` once if Chromium is missing.

To run against another relay instead of a local one, for example n0's public relay
(rate-limited, development only):

```sh
IROH_RELAY_URL=https://use1-1.relay.n0.iroh.link/ pnpm test
```

`IROH_RELAY_BIN` overrides the path to the `iroh-relay` binary.

## Example

```sh
pnpm example      # Vite dev server for examples/echo
```

Open the page in two tabs, bind an endpoint in each (leave the relay field empty for
n0's public relays, or run `iroh-relay --dev` and enter `http://localhost:3340`), paste
one tab's ticket into the other and send.

## API

Everything is exported from `@daviroo/iroh-web`. All async operations reject with an `IrohError`.

```ts
import { Endpoint, EndpointAddr, IrohError, SecretKey, readAll, writeAll } from '@daviroo/iroh-web'

const ALPN = 'my-app/echo/0'

// Bind. Omit relayUrls for n0's public relays (dev only).
const ep = await Endpoint.bind({
  secretKey: SecretKey.generate(),      // optional; persist toBytes() to keep an identity
  alpns: [ALPN],                        // optional; empty means dial-only
  relayUrls: ['https://relay.example.com/'],
})
await ep.online()                        // wait for the home relay
const ticket = ep.addr.toTicket()        // "endpoint..." string, put it in a QR code

// Accept side.
for await (const conn of ep.incoming()) {
  const { writable, readable } = await conn.acceptBi()
  await writeAll(writable, await readAll(readable))   // echo and finish the stream
  await conn.closed                                   // settles when either side closes
}

// Dial side.
const conn = await ep.connect(ticket, ALPN)           // EndpointAddr, ticket, or bare id
const { writable, readable } = await conn.openBi()
await writeAll(writable, 'hello')                      // writes, then close() -> QUIC FIN
const reply = await readAll(readable)
conn.close(0, 'done')
await ep.close()
```

### `Endpoint`

| Member | Description |
|--------|-------------|
| `Endpoint.bind(options?)` | `options.secretKey?: SecretKey`, `options.alpns?: (string \| Uint8Array)[]`, `options.relayUrls?: string[]` |
| `id` | hex-encoded endpoint id (public key) |
| `addr` | `EndpointAddr` with the relay URLs known so far; call `online()` first |
| `online()` | resolves once connected to a home relay |
| `connect(target, alpn)` | `target` is an `EndpointAddr`, a ticket string, or a bare id; returns a `Connection` |
| `accept()` | next incoming `Connection`, or `undefined` once closed |
| `incoming()` | the same as an async iterable |
| `close()` | closes the endpoint and all connections |
| `isClosed` | whether `close()` was called |

### `Connection`

| Member | Description |
|--------|-------------|
| `remoteId`, `alpn`, `alpnString` | peer id and negotiated ALPN |
| `openBi()`, `acceptBi()` | `{ writable: WritableStream<Uint8Array>, readable: ReadableStream<Uint8Array> }` |
| `openUni()`, `acceptUni()` | a `WritableStream` or a `ReadableStream` |
| `close(errorCode = 0, reason = '')` | closes immediately; in-flight data may be lost, so finish your protocol first |
| `closed` | promise that resolves (never rejects) with an `IrohError` describing why the connection closed |

Streams map onto QUIC as follows. Closing a `WritableStream` sends FIN (`finish`);
aborting it resets the stream. A `ReadableStream` ends when the peer finishes;
cancelling it sends `STOP_SENDING`. A stream opened with `openBi()` is only visible to
the peer once data has been written.

### `EndpointAddr`, `SecretKey`

- `new EndpointAddr(id, relayUrls?)`, `EndpointAddr.fromTicket(s)`, `EndpointAddr.parse(ticketOrId)`,
  `addr.toTicket()`, `addr.id`, `addr.relayUrls`.
- `SecretKey.generate()`, `SecretKey.fromBytes(bytes)`, `key.toBytes()`, `key.id`.

Tickets use the `iroh-tickets` `EndpointTicket` format and are interchangeable with
other iroh implementations.

### `IrohError`

`err.code` is one of:

| Code | Meaning |
|------|---------|
| `invalid_argument` | bad key, id, ticket, relay URL, ALPN or chunk type |
| `bind_failed` | the endpoint could not be created |
| `endpoint_closed` | operation on a closed endpoint |
| `self_connect` | tried to dial our own id |
| `no_address` | nothing to dial: no relay URL in the address and no lookup service |
| `connect_failed` | other connection setup failure |
| `handshake_failed` | TLS handshake or peer authentication failed |
| `rejected` | connection rejected locally (hooks) |
| `application_closed` | peer closed with an application code; `errorCode` and `reason` are set |
| `connection_closed` | peer aborted at the transport level, for example an ALPN mismatch |
| `timed_out` | idle timeout, typically a lost relay connection |
| `locally_closed` | we closed the connection |
| `reset` | connection reset by peer |
| `transport_error` | any other QUIC transport error |
| `stream_stopped` | peer stopped reading this send stream; `errorCode` set |
| `stream_reset` | peer reset this receive stream; `errorCode` set |
| `stream_closed` | stream already finished or reset |
| `internal` | anything else |

### Logging

`initLogging('debug')` routes iroh's internal `tracing` output to the browser console.
Call it at most once per page load.

## Notes on the iroh 1.2 browser build

- iroh's `N0` preset works in the browser: relays plus pkarr publish and resolve over
  HTTPS; only the plain-DNS lookup is compiled out. `bind_addr`, `dns_resolver`,
  `bound_sockets` and the port mapper do not exist under `cfg(wasm_browser)`.
- `getrandom` 0.4 (`wasm_js` feature) is what iroh 1.2 uses; the crate also needs the
  `--cfg getrandom_backend="wasm_js"` rustflag for the `getrandom` 0.3 copy deeper in
  the tree. Both are set in `Cargo.toml` and `.cargo/config.toml`.
- `wasm-streams` must stay on the same version iroh-relay pulls in (0.5 today). With two
  copies, `wasm-bindgen` emits renamed `IntoUnderlyingSink2` style classes that the
  glue then fails to import.
- `wasm-bindgen` async methods that borrow `&self` hold the object for the whole call,
  so a pending `accept()` would block `connect()`. The crate therefore returns
  promises built from a cloned `iroh::Endpoint` / `Connection` instead.
- `@number0/iroh` 1.1.0 can dial a relay-only browser peer, so both directions are
  tested. Its `package.json` `main` points at a missing file; import
  `@number0/iroh/index.js` directly.
- Rust `iroh = "=1.0.0"` is also tested in both directions through the local
  relay, with a separate Cargo.lock under `tests/native-iroh-1/`.

## Acknowledgements

The wasm-bindgen setup follows n0's `browser-echo` and `browser-chat` examples in
[iroh-examples](https://github.com/n0-computer/iroh-examples), licensed
MIT OR Apache-2.0.

## License

MIT OR Apache-2.0, matching iroh. See `LICENSE-MIT` and `LICENSE-APACHE`.
