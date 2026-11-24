import { afterEach, describe, expect, inject, test } from 'vitest'
import { Endpoint } from '@daviroo/iroh-web'
import { relayWebSocketUrl } from '../../packages/iroh-web/src/relay-websocket-url.js'

const relayUrl = inject('relayUrl')

describe('relayWebSocketUrl', () => {
  test('strips the trailing dot from a fully qualified relay hostname', () => {
    expect(relayWebSocketUrl('wss://euc1-1.relay.n0.iroh.link./relay')).toBe(
      'wss://euc1-1.relay.n0.iroh.link/relay',
    )
  })

  test('keeps the port, path and query when stripping the dot', () => {
    expect(relayWebSocketUrl('wss://relay.example.com.:8443/base/relay?token=a.b.')).toBe(
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
      expect(relayWebSocketUrl(url)).toBe(url)
    }
  })
})

describe('relay WebSocket dial', () => {
  const Original = globalThis.WebSocket
  afterEach(() => {
    globalThis.WebSocket = Original
  })

  test('opens the relay WebSocket without the trailing dot, keeping the relay URL as given', async () => {
    const opened: string[] = []
    globalThis.WebSocket = class extends Original {
      constructor(url: string | URL, protocols?: string | string[]) {
        opened.push(String(url))
        super(url, protocols)
      }
    }

    const local = new URL(relayUrl)
    const dotted = `${local.protocol}//${local.hostname}.:${local.port}/`
    const endpoint = await Endpoint.bind({ relayUrls: [dotted] })
    try {
      await endpoint.online()
      expect(opened).toContain(`ws://${local.hostname}:${local.port}/relay`)
      expect(opened.some((url) => new URL(url).hostname.endsWith('.'))).toBe(false)
      expect(endpoint.addr.relayUrls).toEqual([dotted])
    } finally {
      await endpoint.close()
    }
  })
})
