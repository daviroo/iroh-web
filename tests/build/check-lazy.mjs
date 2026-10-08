import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { build, preview } from 'vite'
import wasm from 'vite-plugin-wasm'
import { chromium } from 'playwright'

const root = fileURLToPath(new URL('.', import.meta.url))
const result = await build({
  root,
  configFile: false,
  plugins: [wasm()],
  optimizeDeps: { exclude: ['@daviroo/iroh-web'] },
  build: { target: 'esnext', manifest: true },
})
const output = result.output
const assets = output.filter((item) => item.type === 'asset' && item.fileName.endsWith('.wasm'))
assert.equal(assets.length, 1, 'wasm must be emitted as a separate asset')
const entry = output.find((item) => item.type === 'chunk' && item.isEntry)
const staticChunks = new Set()
function visit(chunk) {
  staticChunks.add(chunk.fileName)
  assert(!Object.keys(chunk.modules).some((id) => id.includes('/iroh-web/')), 'iroh must not be in the initial static graph')
  for (const name of chunk.imports) visit(output.find((item) => item.fileName === name))
}
visit(entry)
assert(output.some((item) => item.type === 'chunk' && !staticChunks.has(item.fileName) && Object.keys(item.modules).some((id) => id.includes('/iroh-web/'))))
console.log('[lazy-build] dist chunks:', output.map((item) => item.fileName).join(', '))

const server = await preview({ root, configFile: false, preview: { host: '127.0.0.1', port: 0 } })
let browser
try {
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  const requests = []
  const errors = []
  page.on('request', (request) => requests.push(request.url()))
  page.on('pageerror', (err) => errors.push(err.message))
  await page.goto(server.resolvedUrls.local[0], { waitUntil: 'networkidle' })
  assert(!requests.some((url) => url.endsWith('.wasm')), 'initial page must not fetch wasm')
  await page.click('#load')
  await page.waitForFunction(() => /^[0-9a-f]{64}$/.test(document.querySelector('#result').textContent))
  assert.equal(requests.filter((url) => url.endsWith('.wasm')).length, 1)
  assert.deepEqual(errors, [])
  console.log('[lazy-build] PASS: no initial wasm request; click imports package, fetches wasm, binds and closes an endpoint')
} finally {
  await browser?.close()
  await new Promise((resolve, reject) => server.httpServer.close((err) => err ? reject(err) : resolve()))
}
