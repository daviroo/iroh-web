import { afterEach, describe, expect, inject, test } from 'vitest'
import { Endpoint } from '@daviroo/iroh-web'
import { requestUrl } from '../../packages/iroh-web/src/request-url.js'

const relayUrl = inject('relayUrl')

describe('requestUrl', () => {
  test('strips the trailing dot from a fully qualified relay hostname', () => {
    expect(requestUrl('wss://euc1-1.relay.n0.iroh.link./relay')).toBe(
      'wss://euc1-1.relay.n0.iroh.link/relay',
    )
  })

  test('keeps the port, path and query when stripping the dot', () => {
    expect(requestUrl('wss://relay.example.com.:8443/base/relay?token=a.b.')).toBe(
      'wss://relay.example.com:8443/base/relay?token=a.b.',
    )
  })

  test('returns URLs without a trailing-dot hostname unchanged', () => {
    for (const url of [
      'wss://relay.example.com:8443/base/relay?token=a.b.',
      'wss://euc1-1.relay.n0.iroh.link/relay',
      'ws://localhost:3340/relay',
      'ws://127.0.0.1:3340/relay',
      'ws://[::1]:3340/relay',
    ]) {
      expect(requestUrl(url)).toBe(url)
    }
  })
})

describe('relay requests from the wasm', () => {
  const OriginalWebSocket = globalThis.WebSocket
  const originalFetch = globalThis.fetch
  afterEach(() => {
    globalThis.WebSocket = OriginalWebSocket
    globalThis.fetch = originalFetch
  })

  test('relay WebSocket and latency probe drop the trailing dot; the relay URL keeps it', async () => {
    const opened: string[] = []
    const fetched: string[] = []
    globalThis.WebSocket = class extends OriginalWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        opened.push(String(url))
        super(url, protocols)
      }
    }
    globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      fetched.push(input instanceof Request ? input.url : String(input))
      return originalFetch(input, init)
    }

    const local = new URL(relayUrl)
    const dotted = `${local.protocol}//${local.hostname}.:${local.port}/`
    const undotted = `${local.hostname}:${local.port}`
    const endpoint = await Endpoint.bind({ relayUrls: [dotted] })
    try {
      await endpoint.online()
      await expect.poll(() => fetched.filter((url) => new URL(url).pathname === '/ping'), { timeout: 20_000 }).not.toEqual([])

      expect(opened).toContain(`ws://${undotted}/relay`)
      expect(fetched).toContain(`${local.protocol}//${undotted}/ping`)
      expect([...opened, ...fetched].filter((url) => new URL(url).hostname.endsWith('.'))).toEqual([])
      expect(endpoint.addr.relayUrls).toEqual([dotted])
    } finally {
      await endpoint.close()
    }
  })
})
