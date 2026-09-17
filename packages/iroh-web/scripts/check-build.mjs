import { existsSync } from 'node:fs'

const required = [
  'pkg/iroh_web_wasm_bg.wasm',
  'pkg/iroh_web_wasm.js',
  'pkg/iroh_web_wasm_bg.js',
  'pkg/iroh_web_wasm.d.ts',
  'pkg/iroh_web_wasm_bg.wasm.d.ts',
  'dist/index.js',
  'dist/index.d.ts',
]
const missing = required.filter((file) => !existsSync(new URL(`../${file}`, import.meta.url)))
if (missing.length) {
  console.error(`Missing build artifacts: ${missing.join(', ')}. Run pnpm build from the repository root before publishing.`)
  process.exit(1)
}
