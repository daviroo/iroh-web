import { afterAll, beforeAll, describe, expect, inject, test } from 'vitest'
import { commands } from '@vitest/browser/context'
import {
  type Connection,
  Endpoint,
  EndpointAddr,
  IrohError,
  SecretKey,
  initLogging,
  readAll,
  writeAll,
} from '@daviroo/iroh-web'

const ALPN = 'iroh-web/test-echo/0'
const relayUrl = inject('relayUrl')

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(out.subarray(i, Math.min(n, i + 65536)))
  return out
}

/**
 * Echo server loop for the browser endpoint: echoes one bi stream per
 * connection and hands every accepted connection to `onConnection`.
 */
async function serveEcho(endpoint: Endpoint, onConnection: (conn: Connection) => void): Promise<void> {
  for await (const conn of endpoint.incoming()) {
    onConnection(conn)
    void (async () => {
      const { writable, readable } = await conn.acceptBi()
      const data = await readAll(readable)
      await writeAll(writable, data)
      await conn.closed
    })().catch((err) => console.warn('browser echo handler failed', err))
  }
}

describe('tickets', () => {
  test('EndpointAddr round-trips through a ticket string', () => {
    const key = SecretKey.generate()
    const addr = new EndpointAddr(key.id, ['https://relay.example.com/', relayUrl])
    const ticket = addr.toTicket()
    expect(ticket).toMatch(/^endpoint[a-z2-7]+$/)
    const back = EndpointAddr.fromTicket(ticket)
    expect(back.id).toBe(addr.id)
    expect(back.relayUrls).toEqual(addr.relayUrls)
    expect(EndpointAddr.parse(ticket)).toEqual(back)
    expect(EndpointAddr.parse(key.id).id).toBe(key.id)
  })

  test('tickets are wire-compatible with @number0/iroh', async () => {
    const addr = new EndpointAddr(SecretKey.generate().id, ['https://relay.example.com/'])
    const parsed = await commands.nodeParseTicket(addr.toTicket())
    expect(parsed.id).toBe(addr.id)
    expect(parsed.relayUrl).toBe('https://relay.example.com/')
  })

  test('secret keys import and export as bytes', () => {
    const key = SecretKey.generate()
    const bytes = key.toBytes()
    expect(bytes).toHaveLength(32)
    expect(SecretKey.fromBytes(bytes).id).toBe(key.id)
    expect(key.id).toMatch(/^[0-9a-f]{64}$/)
    expect(() => SecretKey.fromBytes(new Uint8Array(5))).toThrowError(IrohError)
  })
})

describe('echo over a relay', () => {
  let browser: Endpoint
  let node: { ticket: string; id: string }
  const accepted: Connection[] = []
  const waiters: ((conn: Connection) => void)[] = []
  /** Resolves with the next connection accepted by the browser's echo loop. */
  const nextAccepted = () => new Promise<Connection>((resolve) => waiters.push(resolve))

  beforeAll(async () => {
    initLogging('warn')
    node = await commands.startNodePeer(relayUrl)
    browser = await Endpoint.bind({ alpns: [ALPN], relayUrls: [relayUrl] })
    await browser.online()
    void serveEcho(browser, (conn) => {
      accepted.push(conn)
      waiters.splice(0).forEach((resolve) => resolve(conn))
    })
  })

  afterAll(async () => {
    await browser.close()
    await commands.stopNodePeer()
  })

  test('endpoint has an id and a relay address once online', () => {
    expect(browser.id).toMatch(/^[0-9a-f]{64}$/)
    expect(browser.addr.id).toBe(browser.id)
    expect(browser.addr.relayUrls).toEqual([`${relayUrl}/`.replace(/\/+$/, '/')])
    expect(browser.isClosed).toBe(false)
  })

  test('browser dials Node and gets its bytes echoed back', async () => {
    const conn = await browser.connect(node.ticket, ALPN)
    expect(conn.remoteId).toBe(node.id)
    expect(conn.alpnString).toBe(ALPN)

    const payload = new TextEncoder().encode('hello from the browser')
    const { writable, readable } = await conn.openBi()
    await writeAll(writable, payload)
    const echoed = await readAll(readable)
    expect(echoed).toEqual(payload)

    conn.close(0, 'done')
    const reason = await conn.closed
    expect(reason.code).toBe('locally_closed')
  })

  test('browser dials Node with a 256 KiB payload', async () => {
    const conn = await browser.connect(EndpointAddr.fromTicket(node.ticket), ALPN)
    const payload = randomBytes(256 * 1024)
    const { writable, readable } = await conn.openBi()
    const sent = writeAll(writable, payload)
    const echoed = await readAll(readable)
    await sent
    expect(echoed.length).toBe(payload.length)
    expect(echoed).toEqual(payload)
    conn.close()
  })

  test('Node dials the browser and gets its bytes echoed back', async () => {
    const ticket = browser.addr.toTicket()
    const payload = Array.from(randomBytes(10_000))
    const result = await commands.nodeDial(ticket, payload)
    expect(result.remoteId).toBe(browser.id)
    expect(result.echoed).toEqual(payload)
    expect(accepted.map((c) => c.remoteId)).toEqual([node.id])
    expect(accepted[0]!.alpnString).toBe(ALPN)
    const reason = await accepted[0]!.closed
    expect(reason.code).toBe('application_closed')
    expect(reason.errorCode).toBe(0)
  })

  test('remote application close surfaces code and reason', async () => {
    const conn = nextAccepted()
    await commands.nodeDialAndClose(browser.addr.toTicket(), 42, 'bye')
    const reason = await (await conn).closed
    expect(reason.code).toBe('application_closed')
    expect(reason.errorCode).toBe(42)
    expect(reason.reason).toBe('bye')
  })

  test('dialling an unknown id without a relay fails with no_address', async () => {
    const err = await browser.connect(SecretKey.generate().id, ALPN).catch((e) => e)
    expect(err).toBeInstanceOf(IrohError)
    expect((err as IrohError).code).toBe('no_address')
  })

  test('dialling with an ALPN the peer does not accept is rejected', async () => {
    const err = await browser.connect(node.ticket, 'iroh-web/nope/0').catch((e) => e)
    expect(err).toBeInstanceOf(IrohError)
    // The peer's QUIC stack aborts the handshake with a crypto error (no_application_protocol),
    // which reaches us as a transport-level close rather than an application close.
    expect((err as IrohError).code).toBe('connection_closed')
    expect((err as IrohError).message).toMatch(/protocol/)
  })
})
