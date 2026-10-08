import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import type { BrowserCommand } from 'vitest/node'

let child: ChildProcessWithoutNullStreams | undefined
let pending: { resolve(value: any): void; reject(err: Error): void } | undefined
let stderr = ''

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

export const startNativePeer: BrowserCommand<[relayUrl: string]> = async (_ctx, relayUrl) => {
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
  child.on('error', (err) => pending?.reject(err))
  child.on('exit', (code) => pending?.reject(new Error(`iroh 1.0 peer exited (${code}):\n${stderr}`)))
  return ready
}

export const nativeDial: BrowserCommand<[ticket: string, payload: number[]]> = async (_ctx, ticket, payload) => {
  if (!child) throw new Error('startNativePeer first')
  const result = response()
  child.stdin.write(`${JSON.stringify({ ticket, payload })}\n`)
  return result
}

export const stopNativePeer: BrowserCommand<[]> = async () => {
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
    nativeDial: (ticket: string, payload: number[]) => Promise<{ echoed: number[]; remoteId: string }>
    stopNativePeer: () => Promise<void>
  }
}
