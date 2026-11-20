import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import type { BrowserCommand } from 'vitest/node'
import type { Route } from 'playwright'

let child: ChildProcessWithoutNullStreams | undefined
let pending: { resolve(value: any): void; reject(err: Error): void } | undefined
let stderr = ''

interface NativePeerReady {
  ticket: string
  id: string
  pkarrKey: string
  pkarrPayload: number[]
}

// Keep pkarr requests off the public service while using the browser's actual
// resolver and the native peer's signed address record.
const pkarrRoute = /^https:\/\/(?:dns|staging-dns)\.iroh\.link\/pkarr\/[^/]+$/
let pkarrHandler: ((route: Route) => Promise<void>) | undefined
let pkarrMethods: string[] = []

function response(): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending = undefined
      reject(new Error(`iroh 1.0 peer response timed out:\n${stderr}`))
      child?.kill()
    }, 40_000)
    pending = {
      resolve: (value) => { clearTimeout(timer); resolve(value) },
      reject: (err) => { clearTimeout(timer); reject(err) },
    }
  })
}

export const startNativePeer: BrowserCommand<[relayUrl: string]> = async (ctx, relayUrl) => {
  const ready = response()
  child = spawn(fileURLToPath(new URL('../native-iroh-1/target/debug/iroh-web-interop-peer', import.meta.url)), [relayUrl])
  stderr = ''
  child.stderr.on('data', (data) => { stderr += data; console.warn(String(data)) })
  createInterface({ input: child.stdout }).on('line', (line) => {
    const waiter = pending
    pending = undefined
    try {
      const value = JSON.parse(line)
      if (value.error) waiter?.reject(new Error(value.error))
      else waiter?.resolve(value)
    } catch (err) { waiter?.reject(new Error(`invalid native response: ${line}`, { cause: err })) }
  })
  child.on('error', (err: NodeJS.ErrnoException) => pending?.reject(
    err.code === 'ENOENT'
      ? new Error('Native iroh 1.0 peer binary not found. From the repository root, run: cargo build --locked --manifest-path tests/native-iroh-1/Cargo.toml', { cause: err })
      : err,
  ))
  child.on('exit', (code) => pending?.reject(new Error(`iroh 1.0 peer exited (${code}):\n${stderr}`)))
  const { ticket, id, pkarrKey, pkarrPayload }: NativePeerReady = await ready
  pkarrMethods = []
  pkarrHandler = async (route) => {
    const request = route.request()
    pkarrMethods.push(request.method())
    const found = request.method() === 'GET' && new URL(request.url()).pathname === `/pkarr/${pkarrKey}`
    await route.fulfill({
      status: found ? 200 : 404,
      headers: { 'access-control-allow-origin': '*' },
      body: found ? Buffer.from(pkarrPayload) : '',
    })
  }
  await ctx.page.route(pkarrRoute, pkarrHandler)
  return { ticket, id }
}

export const nativePkarrMethods: BrowserCommand<[]> = async () => pkarrMethods

export const nativeDial: BrowserCommand<[ticket: string, payload: number[]]> = async (_ctx, ticket, payload) => {
  if (!child) throw new Error('startNativePeer first')
  const result = response()
  child.stdin.write(`${JSON.stringify({ ticket, payload })}\n`)
  return result
}

export const stopNativePeer: BrowserCommand<[]> = async (ctx) => {
  if (pkarrHandler) {
    await ctx.page.unroute(pkarrRoute, pkarrHandler)
    pkarrHandler = undefined
  }
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const stopped = new Promise<void>((resolve) => child!.once('exit', () => resolve()))
  child.stdin.end()
  const timer = setTimeout(() => child?.kill(), 5000)
  await stopped
  clearTimeout(timer)
  child = undefined
}

declare module '@vitest/browser/context' {
  interface BrowserCommands {
    startNativePeer: (relayUrl: string) => Promise<{ ticket: string; id: string }>
    nativePkarrMethods: () => Promise<string[]>
    nativeDial: (ticket: string, payload: number[]) => Promise<{ echoed: number[]; remoteId: string }>
    stopNativePeer: () => Promise<void>
  }
}
