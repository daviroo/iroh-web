import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import type { BrowserCommand } from 'vitest/node'
import type { Route } from 'playwright'

interface NativePeerReady {
  ticket: string
  id: string
  pkarrKey: string
  pkarrPayload: number[]
}

// Keep pkarr requests off the public service while using the browser's actual
// resolver and the native peer's signed address record.
const pkarrRoute = /^https:\/\/(?:dns|staging-dns)\.iroh\.link\/pkarr\/[^/]+$/

// One native peer per browser session: browser instances (chromium, firefox,
// webkit) run their test files concurrently in this Node process.
interface NativePeer {
  child: ChildProcessWithoutNullStreams
  pending: { resolve(value: any): void; reject(err: Error): void } | undefined
  stderr: string
  pkarrHandler: ((route: Route) => Promise<void>) | undefined
  pkarrMethods: string[]
}

const natives = new Map<string, NativePeer>()

function response(native: NativePeer): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      native.pending = undefined
      reject(new Error(`iroh 1.0 peer response timed out:\n${native.stderr}`))
      native.child.kill()
    }, 40_000)
    native.pending = {
      resolve: (value) => { clearTimeout(timer); resolve(value) },
      reject: (err) => { clearTimeout(timer); reject(err) },
    }
  })
}

export const startNativePeer: BrowserCommand<[relayUrl: string]> = async (ctx, relayUrl) => {
  const child = spawn(fileURLToPath(new URL('../native-iroh-1/target/debug/iroh-web-interop-peer', import.meta.url)), [relayUrl])
  const native: NativePeer = { child, pending: undefined, stderr: '', pkarrHandler: undefined, pkarrMethods: [] }
  natives.set(ctx.sessionId, native)
  const ready = response(native)
  child.stderr.on('data', (data) => { native.stderr += data; console.warn(String(data)) })
  createInterface({ input: child.stdout }).on('line', (line) => {
    const waiter = native.pending
    native.pending = undefined
    try {
      const value = JSON.parse(line)
      if (value.error) waiter?.reject(new Error(value.error))
      else waiter?.resolve(value)
    } catch (err) { waiter?.reject(new Error(`invalid native response: ${line}`, { cause: err })) }
  })
  child.on('error', (err: NodeJS.ErrnoException) => native.pending?.reject(
    err.code === 'ENOENT'
      ? new Error('Native iroh 1.0 peer binary not found. From the repository root, run: cargo build --locked --manifest-path tests/native-iroh-1/Cargo.toml', { cause: err })
      : err,
  ))
  child.on('exit', (code) => native.pending?.reject(new Error(`iroh 1.0 peer exited (${code}):\n${native.stderr}`)))
  const { ticket, id, pkarrKey, pkarrPayload }: NativePeerReady = await ready
  native.pkarrHandler = async (route) => {
    const request = route.request()
    native.pkarrMethods.push(request.method())
    const found = request.method() === 'GET' && new URL(request.url()).pathname === `/pkarr/${pkarrKey}`
    await route.fulfill({
      status: found ? 200 : 404,
      headers: { 'access-control-allow-origin': '*' },
      body: found ? Buffer.from(pkarrPayload) : '',
    })
  }
  await ctx.page.route(pkarrRoute, native.pkarrHandler)
  return { ticket, id }
}

export const nativePkarrMethods: BrowserCommand<[]> = async (ctx) => natives.get(ctx.sessionId)?.pkarrMethods ?? []

export const nativeDial: BrowserCommand<[ticket: string, payload: number[]]> = async (ctx, ticket, payload) => {
  const native = natives.get(ctx.sessionId)
  if (!native) throw new Error('startNativePeer first')
  const result = response(native)
  native.child.stdin.write(`${JSON.stringify({ ticket, payload })}\n`)
  return result
}

export const stopNativePeer: BrowserCommand<[]> = async (ctx) => {
  const native = natives.get(ctx.sessionId)
  if (!native) return
  natives.delete(ctx.sessionId)
  if (native.pkarrHandler) await ctx.page.unroute(pkarrRoute, native.pkarrHandler)
  const { child } = native
  if (child.exitCode !== null || child.signalCode !== null) return
  const stopped = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  child.stdin.end()
  const timer = setTimeout(() => child.kill(), 5000)
  await stopped
  clearTimeout(timer)
}

declare module '@vitest/browser/context' {
  interface BrowserCommands {
    startNativePeer: (relayUrl: string) => Promise<{ ticket: string; id: string }>
    nativePkarrMethods: () => Promise<string[]>
    nativeDial: (ticket: string, payload: number[]) => Promise<{ echoed: number[]; remoteId: string }>
    stopNativePeer: () => Promise<void>
  }
}
