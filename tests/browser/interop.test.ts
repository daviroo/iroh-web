import { afterAll, beforeAll, describe, expect, inject, test } from 'vitest'
import { commands } from '@vitest/browser/context'
import { Endpoint, EndpointAddr, readAll, writeAll } from '@daviroo/iroh-web'

const ALPN = 'iroh-web/test-echo/0'

describe('iroh 1.2 browser ↔ Rust iroh =1.0.0 (relay-only)', () => {
  let browser: Endpoint | undefined
  let native: { ticket: string; id: string }

  beforeAll(async () => {
    native = await commands.startNativePeer(inject('relayUrl'))
    browser = await Endpoint.bind({ alpns: [ALPN], relayUrls: [inject('relayUrl')] })
    await browser.online()
  })

  afterAll(async () => {
    await browser?.close()
    await commands.stopNativePeer()
  })

  test('lookup-only endpoint resolves a bare peer ID without publishing', async () => {
    const endpoint = await Endpoint.bindLookupOnly({ relayUrls: [inject('relayUrl')] })
    try {
      await endpoint.online()
      const conn = await endpoint.connect(native.id, ALPN)
      try {
        expect(conn.remoteId).toBe(native.id)
        const { writable, readable } = await conn.openBi()
        const payload = new TextEncoder().encode('bare ID request')
        await writeAll(writable, payload)
        expect(await readAll(readable)).toEqual(payload)
      } finally { conn.close() }
    } finally { await endpoint.close() }
    const methods = await commands.nativePkarrMethods()
    expect(methods).toContain('GET')
    expect(methods.every((method) => method === 'GET')).toBe(true)
  })

  test('browser dials native ticket; request FIN precedes echo and response FIN', async () => {
    expect(EndpointAddr.fromTicket(native.ticket).relayUrls).toEqual(browser!.addr.relayUrls)
    const conn = await browser!.connect(native.ticket, ALPN)
    try {
      expect(conn.remoteId).toBe(native.id)
      expect(conn.alpnString).toBe(ALPN)
      const { writable, readable } = await conn.openBi()
      const payload = new Uint8Array(256 * 1024).map((_, i) => i % 251)
      await writeAll(writable, payload)
      expect(await readAll(readable)).toEqual(payload)
    } finally { conn.close() }
  })

  test('native dials browser ticket; bytes and FIN work in both directions', async () => {
    const payload = Array.from(new TextEncoder().encode('iroh 1.0 → browser: request + FIN'))
    const serving = (async () => {
      const conn = await browser!.accept()
      expect(conn!.remoteId).toBe(native.id)
      expect(conn!.alpnString).toBe(ALPN)
      const { writable, readable } = await conn!.acceptBi()
      const request = await readAll(readable)
      expect(Array.from(request)).toEqual(payload)
      await writeAll(writable, request)
      await conn!.closed
    })()
    const result = await commands.nativeDial(browser!.addr.toTicket(), payload)
    expect(result).toEqual({ echoed: payload, remoteId: browser!.id })
    await serving
  })
})
