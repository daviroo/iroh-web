// A Node.js iroh peer built on @number0/iroh, driven from browser tests through
// vitest browser commands. Every command runs in the Vitest Node process.
import {
  Endpoint,
  EndpointTicket,
  RelayMode,
  presetMinimal,
  type Connection,
  // The package's `main` field points at a missing file, so import the entry directly.
} from '@number0/iroh/index.js'
import type { BrowserCommand } from 'vitest/node'

export const ECHO_ALPN = 'iroh-web/test-echo/0'
const alpnBytes = Array.from(new TextEncoder().encode(ECHO_ALPN))

interface Peer {
  endpoint: Endpoint
  ticket: string
  /** Remote ids that were accepted, in order. */
  accepted: string[]
}

let peer: Peer | undefined

async function echo(conn: Connection): Promise<void> {
  const bi = await conn.acceptBi()
  const data = await bi.recv.readToEnd(4 * 1024 * 1024)
  await bi.send.writeAll(data)
  await bi.send.finish()
  // Wait for the dialler to close so the last bytes are acknowledged first.
  await conn.closed()
}

async function acceptLoop(p: Peer): Promise<void> {
  for (;;) {
    const incoming = await p.endpoint.acceptNext()
    if (!incoming) return
    void (async () => {
      try {
        const accepting = await incoming.accept()
        const conn = await accepting.connect()
        p.accepted.push(conn.remoteId().toString())
        await echo(conn)
      } catch (err) {
        console.warn('[node-peer] incoming connection failed:', err)
      }
    })()
  }
}

/** Starts (or returns) the Node echo peer and returns its ticket. */
export const startNodePeer: BrowserCommand<[relayUrl: string]> = async (_ctx, relayUrl) => {
  if (peer) return { ticket: peer.ticket, id: peer.endpoint.id().toString() }
  const builder = Endpoint.builder()
  presetMinimal(builder)
  builder.relayMode(RelayMode.customFromUrls([relayUrl]))
  builder.alpns([alpnBytes])
  const endpoint = await builder.bind()
  await endpoint.online()
  const ticket = EndpointTicket.fromAddr(endpoint.addr()).toString()
  peer = { endpoint, ticket, accepted: [] }
  void acceptLoop(peer)
  return { ticket, id: endpoint.id().toString() }
}

/** Dials `ticket` from the Node peer, sends `payload` on a bi stream and returns the echoed bytes. */
export const nodeDial: BrowserCommand<[ticket: string, payload: number[]]> = async (
  _ctx,
  ticket,
  payload,
) => {
  if (!peer) throw new Error('startNodePeer first')
  const addr = EndpointTicket.fromString(ticket).endpointAddr()
  const conn = await peer.endpoint.connect(addr, alpnBytes)
  const bi = await conn.openBi()
  await bi.send.writeAll(payload)
  await bi.send.finish()
  const echoed = await bi.recv.readToEnd(4 * 1024 * 1024)
  conn.close(0n, [])
  return { echoed, remoteId: conn.remoteId().toString() }
}

/** Dials `ticket` and immediately closes the connection with an application error code. */
export const nodeDialAndClose: BrowserCommand<[ticket: string, errorCode: number, reason: string]> =
  async (_ctx, ticket, errorCode, reason) => {
    if (!peer) throw new Error('startNodePeer first')
    const addr = EndpointTicket.fromString(ticket).endpointAddr()
    const conn = await peer.endpoint.connect(addr, alpnBytes)
    // Open a stream so the browser side has accepted the connection before we close.
    const bi = await conn.openBi()
    await bi.send.writeAll([1])
    await bi.send.finish()
    await bi.recv.readToEnd(16)
    conn.close(BigInt(errorCode), Array.from(new TextEncoder().encode(reason)))
    return conn.remoteId().toString()
  }

/** Parses a ticket with the Node implementation to check wire compatibility. */
export const nodeParseTicket: BrowserCommand<[ticket: string]> = async (_ctx, ticket) => {
  const addr = EndpointTicket.fromString(ticket).endpointAddr()
  return { id: addr.id().toString(), relayUrl: addr.relayUrl() }
}

export const stopNodePeer: BrowserCommand<[]> = async () => {
  if (!peer) return
  await peer.endpoint.close()
  peer = undefined
}

declare module '@vitest/browser/context' {
  interface BrowserCommands {
    startNodePeer: (relayUrl: string) => Promise<{ ticket: string; id: string }>
    nodeDial: (ticket: string, payload: number[]) => Promise<{ echoed: number[]; remoteId: string }>
    nodeDialAndClose: (ticket: string, errorCode: number, reason: string) => Promise<string>
    nodeParseTicket: (ticket: string) => Promise<{ id: string; relayUrl: string | null }>
    stopNodePeer: () => Promise<void>
  }
}
