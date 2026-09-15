/**
 * iroh-web: an iroh endpoint in the browser.
 *
 * Thin, typed wrapper over the wasm-bindgen exports in `../pkg`. The wasm layer
 * is deliberately minimal; everything ergonomic (option objects, typed errors,
 * async iteration) lives here.
 *
 * Browser endpoints are relay-only: they reach peers through an iroh relay over
 * WebSocket, with no direct UDP paths or hole punching.
 */
import * as wasm from '../pkg/iroh_web_wasm.js'

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Stable error codes. Distinguish relay/connect failures from peer rejections with these. */
export type IrohErrorCode =
  | 'invalid_argument'
  | 'internal'
  | 'bind_failed'
  | 'endpoint_closed'
  | 'self_connect'
  | 'no_address'
  | 'connect_failed'
  | 'handshake_failed'
  | 'rejected'
  | 'application_closed'
  | 'connection_closed'
  | 'timed_out'
  | 'locally_closed'
  | 'reset'
  | 'transport_error'
  | 'stream_stopped'
  | 'stream_reset'
  | 'stream_closed'

/** Error thrown by every iroh-web operation. */
export class IrohError extends Error {
  override readonly name = 'IrohError'
  readonly code: IrohErrorCode
  /** Application error code, for `application_closed`, `stream_stopped` and `stream_reset`. */
  readonly errorCode: number | undefined
  /** Close reason sent by the peer, for `application_closed`. */
  readonly reason: string | undefined

  constructor(code: IrohErrorCode, message: string, extra: { errorCode?: number; reason?: string; cause?: unknown } = {}) {
    super(message, extra.cause === undefined ? undefined : { cause: extra.cause })
    this.code = code
    this.errorCode = extra.errorCode
    this.reason = extra.reason
  }

  /** Converts anything thrown by the wasm layer into an `IrohError`. */
  static from(err: unknown): IrohError {
    if (err instanceof IrohError) return err
    if (err instanceof Error) {
      const e = err as Error & { code?: unknown; errorCode?: unknown; reason?: unknown }
      const code = typeof e.code === 'string' ? (e.code as IrohErrorCode) : 'internal'
      return new IrohError(code, err.message, {
        ...(typeof e.errorCode === 'number' ? { errorCode: e.errorCode } : {}),
        ...(typeof e.reason === 'string' ? { reason: e.reason } : {}),
        cause: err,
      })
    }
    return new IrohError('internal', String(err), { cause: err })
  }
}

async function wrap<T>(promise: Promise<T>): Promise<T> {
  try {
    return await promise
  } catch (err) {
    throw IrohError.from(err)
  }
}

function sync<T>(fn: () => T): T {
  try {
    return fn()
  } catch (err) {
    throw IrohError.from(err)
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

/** ALPNs are bytes on the wire; strings are encoded as UTF-8 for convenience. */
export type Alpn = string | Uint8Array

function alpnBytes(alpn: Alpn): Uint8Array {
  return typeof alpn === 'string' ? textEncoder.encode(alpn) : alpn
}

/** Reads a stream to completion and concatenates the chunks. */
export async function readAll(readable: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let total = 0
  const reader = readable.getReader()
  try {
    for (;;) {
      const { done, value } = await wrap(reader.read())
      if (done) break
      chunks.push(value)
      total += value.length
    }
  } finally {
    reader.releaseLock()
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

/** Writes `data` to a stream and, by default, closes it (finishing the QUIC stream). */
export async function writeAll(
  writable: WritableStream<Uint8Array>,
  data: Uint8Array | string,
  options: { close?: boolean } = {},
): Promise<void> {
  const writer = writable.getWriter()
  try {
    await wrap(writer.write(typeof data === 'string' ? textEncoder.encode(data) : data))
    if (options.close ?? true) await wrap(writer.close())
  } finally {
    writer.releaseLock()
  }
}

// ---------------------------------------------------------------------------
// Keys and addresses
// ---------------------------------------------------------------------------

/** An ed25519 secret key identifying an endpoint. */
export class SecretKey {
  readonly #bytes: Uint8Array

  private constructor(bytes: Uint8Array) {
    this.#bytes = bytes
  }

  /** Generates a new random key. */
  static generate(): SecretKey {
    return new SecretKey(wasm.generateSecretKey())
  }

  /** Imports a key from its 32 raw bytes. */
  static fromBytes(bytes: Uint8Array): SecretKey {
    sync(() => wasm.secretKeyToId(bytes)) // validates length
    return new SecretKey(new Uint8Array(bytes))
  }

  /** Exports the 32 raw key bytes. */
  toBytes(): Uint8Array {
    return new Uint8Array(this.#bytes)
  }

  /** The endpoint id (hex public key) derived from this key. */
  get id(): string {
    return wasm.secretKeyToId(this.#bytes)
  }
}

/** An endpoint id plus the relay URLs it can be reached through. */
export class EndpointAddr {
  readonly id: string
  readonly relayUrls: readonly string[]

  constructor(id: string, relayUrls: readonly string[] = []) {
    const inner = sync(() => new wasm.EndpointAddr(id, [...relayUrls]))
    try {
      this.id = inner.id()
      this.relayUrls = inner.relayUrls()
    } finally {
      inner.free()
    }
  }

  /** Parses an `endpoint…` ticket string. */
  static fromTicket(ticket: string): EndpointAddr {
    const inner = sync(() => wasm.EndpointAddr.fromTicket(ticket))
    try {
      return new EndpointAddr(inner.id(), inner.relayUrls())
    } finally {
      inner.free()
    }
  }

  /**
   * Parses either a ticket or a bare endpoint id.
   *
   * A bare id only works when the endpoint uses the default n0 relays and
   * address lookup; prefer tickets, which carry the relay URL.
   */
  static parse(addrOrTicketOrId: string): EndpointAddr {
    const s = addrOrTicketOrId.trim()
    if (s.startsWith('endpoint')) return EndpointAddr.fromTicket(s)
    return new EndpointAddr(s)
  }

  /** Encodes this address as a ticket string, suitable for a QR code. */
  toTicket(): string {
    const inner = sync(() => new wasm.EndpointAddr(this.id, [...this.relayUrls]))
    try {
      return inner.toTicket()
    } finally {
      inner.free()
    }
  }

  toString(): string {
    return this.toTicket()
  }

  toJSON(): { id: string; relayUrls: string[] } {
    return { id: this.id, relayUrls: [...this.relayUrls] }
  }

  /** @internal */
  toWasm(): wasm.EndpointAddr {
    return sync(() => new wasm.EndpointAddr(this.id, [...this.relayUrls]))
  }
}

// ---------------------------------------------------------------------------
// Endpoint
// ---------------------------------------------------------------------------

export interface EndpointOptions {
  /** Identity of the endpoint. A fresh key is generated when omitted. */
  secretKey?: SecretKey
  /** ALPNs to accept incoming connections for. Leave empty for a dial-only endpoint. */
  alpns?: readonly Alpn[]
  /**
   * Relay servers to use. When omitted, n0's public relays and pkarr address
   * publishing are used (fine for development, rate-limited; self-host for
   * production). When given, only these relays are used and no address lookup
   * service is configured, so peers must be dialled with a ticket or an
   * address that includes a relay URL.
   */
  relayUrls?: readonly string[]
}

/** A bound iroh endpoint. */
export class Endpoint {
  readonly #inner: wasm.Endpoint

  private constructor(inner: wasm.Endpoint) {
    this.#inner = inner
  }

  /** Creates and binds an endpoint. */
  static async bind(options: EndpointOptions = {}): Promise<Endpoint> {
    const inner = await wrap(
      wasm.Endpoint.bind(
        options.secretKey?.toBytes(),
        (options.alpns ?? []).map(alpnBytes),
        options.relayUrls === undefined ? undefined : [...options.relayUrls],
      ),
    )
    return new Endpoint(inner)
  }

  /** The hex-encoded endpoint id. */
  get id(): string {
    return this.#inner.id()
  }

  /** The current address. Await `online()` first so it includes a relay URL. */
  get addr(): EndpointAddr {
    const inner = this.#inner.addr()
    try {
      return new EndpointAddr(inner.id(), inner.relayUrls())
    } finally {
      inner.free()
    }
  }

  /** Resolves once the endpoint is connected to a home relay. */
  online(): Promise<void> {
    return wrap(this.#inner.online())
  }

  /** Connects to a peer given an `EndpointAddr`, a ticket string, or a bare endpoint id. */
  async connect(target: EndpointAddr | string, alpn: Alpn): Promise<Connection> {
    const addr = typeof target === 'string' ? EndpointAddr.parse(target) : target
    const wasmAddr = addr.toWasm()
    try {
      const conn = await wrap(this.#inner.connect(wasmAddr, alpnBytes(alpn)))
      return new Connection(conn)
    } finally {
      wasmAddr.free()
    }
  }

  /** Waits for the next incoming connection; resolves `undefined` once the endpoint is closed. */
  async accept(): Promise<Connection | undefined> {
    const conn = await wrap(this.#inner.accept())
    return conn === undefined ? undefined : new Connection(conn)
  }

  /** Incoming connections as an async iterable; ends when the endpoint is closed. */
  async *incoming(): AsyncGenerator<Connection, void, undefined> {
    for (;;) {
      const conn = await this.accept()
      if (conn === undefined) return
      yield conn
    }
  }

  /** Closes the endpoint and all its connections. */
  async close(): Promise<void> {
    await wrap(this.#inner.close())
  }

  /** Whether `close()` has been called. */
  get isClosed(): boolean {
    return this.#inner.isClosed()
  }
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

/** Both halves of a bidirectional stream. */
export interface BiStream {
  writable: WritableStream<Uint8Array>
  readable: ReadableStream<Uint8Array>
}

/** An established connection to a remote endpoint. */
export class Connection {
  readonly #inner: wasm.Connection
  readonly remoteId: string
  readonly alpn: Uint8Array
  #closed: Promise<IrohError> | undefined

  /** @internal */
  constructor(inner: wasm.Connection) {
    this.#inner = inner
    this.remoteId = inner.remoteId()
    this.alpn = inner.alpn()
  }

  /** The negotiated ALPN decoded as UTF-8. */
  get alpnString(): string {
    return textDecoder.decode(this.alpn)
  }

  /**
   * Opens a bidirectional stream. The remote only learns about it once data
   * is written.
   */
  async openBi(): Promise<BiStream> {
    const [writable, readable] = await wrap(this.#inner.openBi())
    return { writable, readable }
  }

  /** Accepts the next bidirectional stream opened by the remote. */
  async acceptBi(): Promise<BiStream> {
    const [writable, readable] = await wrap(this.#inner.acceptBi())
    return { writable, readable }
  }

  /** Opens a unidirectional send stream. */
  openUni(): Promise<WritableStream<Uint8Array>> {
    return wrap(this.#inner.openUni())
  }

  /** Accepts the next unidirectional stream opened by the remote. */
  acceptUni(): Promise<ReadableStream<Uint8Array>> {
    return wrap(this.#inner.acceptUni())
  }

  /**
   * Closes the connection immediately. Data still in flight may be lost, so
   * only close after the application protocol has completed.
   */
  close(errorCode = 0, reason: string | Uint8Array = ''): void {
    this.#inner.close(errorCode, typeof reason === 'string' ? textEncoder.encode(reason) : reason)
  }

  /**
   * Resolves (never rejects) with the reason once the connection is closed,
   * by either side. `code` is `locally_closed` after a local `close()` and
   * `application_closed` after a remote one.
   */
  get closed(): Promise<IrohError> {
    this.#closed ??= this.#inner.closed().then((e) => IrohError.from(e))
    return this.#closed
  }
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

export type LogLevel = 'off' | 'error' | 'warn' | 'info' | 'debug' | 'trace'

/** Routes iroh's internal logs to the browser console. Call at most once per page load. */
export function initLogging(level: LogLevel = 'info'): void {
  sync(() => wasm.initLogging(level))
}
