// Starts a local `iroh-relay --dev` for the test run, unless IROH_RELAY_URL
// points at an existing relay (for example one of n0's public relays).
import { spawn, type ChildProcess } from 'node:child_process'
import { createConnection } from 'node:net'

export const DEV_RELAY_PORT = 3340
export const DEV_RELAY_URL = `http://localhost:${DEV_RELAY_PORT}`

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ host: '127.0.0.1', port })
    sock.once('connect', () => {
      sock.destroy()
      resolve(true)
    })
    sock.once('error', () => resolve(false))
  })
}

export interface RelayHandle {
  url: string
  stop(): Promise<void>
}

export async function startRelay(): Promise<RelayHandle> {
  const external = process.env.IROH_RELAY_URL
  if (external) {
    console.log(`[relay] using external relay ${external}`)
    return { url: external, stop: async () => {} }
  }
  if (await portOpen(DEV_RELAY_PORT)) {
    // Either a relay left running by hand, or a second vitest project setting up.
    console.log(`[relay] reusing relay already listening at ${DEV_RELAY_URL}`)
    return { url: DEV_RELAY_URL, stop: async () => {} }
  }
  const bin = process.env.IROH_RELAY_BIN ?? 'iroh-relay'
  const child: ChildProcess = spawn(bin, ['--dev'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, RUST_LOG: process.env.RUST_LOG ?? 'warn' },
  })
  let output = ''
  child.stdout?.on('data', (d) => (output += d))
  child.stderr?.on('data', (d) => (output += d))
  const exited = new Promise<never>((_, reject) => {
    child.once('error', (err) =>
      reject(new Error(`failed to start ${bin}: ${err.message}. Install it from https://github.com/n0-computer/iroh/releases or set IROH_RELAY_BIN.`)),
    )
    child.once('exit', (code) => reject(new Error(`${bin} exited with code ${code}:\n${output}`)))
  })
  const ready = (async () => {
    for (let i = 0; i < 100; i++) {
      if (await portOpen(DEV_RELAY_PORT)) return
      await new Promise((r) => setTimeout(r, 100))
    }
    throw new Error(`${bin} did not start listening on ${DEV_RELAY_PORT}:\n${output}`)
  })()
  await Promise.race([ready, exited])
  console.log(`[relay] started ${bin} --dev at ${DEV_RELAY_URL}`)
  return {
    url: DEV_RELAY_URL,
    stop: () =>
      new Promise((resolve) => {
        child.once('exit', () => resolve())
        child.kill('SIGTERM')
      }),
  }
}
