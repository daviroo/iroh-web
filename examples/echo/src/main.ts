import { Endpoint, IrohError, initLogging, readAll, writeAll } from 'iroh-web'

const ALPN = 'iroh-web/example-echo/0'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const logEl = $<HTMLPreElement>('log')
const log = (...parts: unknown[]) => {
  logEl.textContent += parts.map(String).join(' ') + '\n'
  console.log(...parts)
}

initLogging('info')
let endpoint: Endpoint | undefined

$<HTMLButtonElement>('bind').onclick = async () => {
  const relay = $<HTMLInputElement>('relay').value.trim()
  try {
    endpoint = await Endpoint.bind({ alpns: [ALPN], ...(relay ? { relayUrls: [relay] } : {}) })
    log('bound endpoint', endpoint.id)
    await endpoint.online()
    $<HTMLTextAreaElement>('ticket').value = endpoint.addr.toTicket()
    $<HTMLButtonElement>('send').disabled = false
    log('online via', endpoint.addr.relayUrls.join(', '))
    void serve(endpoint)
  } catch (err) {
    log('bind failed:', err instanceof IrohError ? `${err.code}: ${err.message}` : err)
  }
}

async function serve(ep: Endpoint) {
  for await (const conn of ep.incoming()) {
    log('accepted connection from', conn.remoteId)
    void (async () => {
      const { writable, readable } = await conn.acceptBi()
      const data = await readAll(readable)
      log('echoing', data.length, 'bytes')
      await writeAll(writable, data)
      const reason = await conn.closed
      log('connection closed:', reason.code)
    })().catch((err) => log('handler failed:', err))
  }
}

$<HTMLButtonElement>('send').onclick = async () => {
  if (!endpoint) return
  const ticket = $<HTMLTextAreaElement>('peer').value.trim()
  const message = $<HTMLInputElement>('message').value
  try {
    const started = performance.now()
    const conn = await endpoint.connect(ticket, ALPN)
    log('connected to', conn.remoteId, `in ${(performance.now() - started).toFixed(0)} ms`)
    const { writable, readable } = await conn.openBi()
    await writeAll(writable, message)
    const echoed = new TextDecoder().decode(await readAll(readable))
    log('echo:', JSON.stringify(echoed))
    conn.close(0, 'done')
  } catch (err) {
    log('dial failed:', err instanceof IrohError ? `${err.code}: ${err.message}` : err)
  }
}
