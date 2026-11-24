import { existsSync, readFileSync } from 'node:fs'

const required = [
  'pkg/iroh_web_wasm_bg.wasm',
  'pkg/iroh_web_wasm.js',
  'pkg/iroh_web_wasm_bg.js',
  'pkg/iroh_web_wasm.d.ts',
  'pkg/iroh_web_wasm_bg.wasm.d.ts',
  'dist/index.js',
  'dist/index.d.ts',
  'dist/relay-websocket-url.js',
]
const missing = required.filter((file) => !existsSync(new URL(`../${file}`, import.meta.url)))
if (missing.length) {
  console.error(`Missing build artifacts: ${missing.join(', ')}. Run pnpm build from the repository root before publishing.`)
  process.exit(1)
}

const glue = readFileSync(new URL('../pkg/iroh_web_wasm_bg.js', import.meta.url), 'utf8')
if (!glue.includes('new WebSocket(relayWebSocketUrl(')) {
  console.error('pkg/iroh_web_wasm_bg.js does not route WebSockets through relayWebSocketUrl. Rebuild with pnpm build.')
  process.exit(1)
}
