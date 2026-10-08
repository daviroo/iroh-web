import { expect, test } from 'vitest'
import { Endpoint, EndpointAddr, IrohError, SecretKey } from '@daviroo/iroh-web'

test('connect to an unreachable relay rejects with timed_out without an application deadline', async () => {
  const relay = 'http://127.0.0.1:65534/'
  const endpoint = await Endpoint.bind({ relayUrls: [relay] })
  const started = performance.now()
  try {
    const target = new EndpointAddr(SecretKey.generate().id, [relay])
    const error = await endpoint.connect(target.toTicket(), 'iroh-web/test-echo/0').catch((err) => err)
    const elapsed = performance.now() - started
    console.log(`[unreachable-relay] connect settled after ${Math.round(elapsed)} ms: ${error.code}: ${error.message}`)
    expect(error).toBeInstanceOf(IrohError)
    expect(error.code).toBe('timed_out')
    expect(elapsed).toBeLessThan(45_000)
  } finally {
    await endpoint.close()
  }
}, 50_000)
