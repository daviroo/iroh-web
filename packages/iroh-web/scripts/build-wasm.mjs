// Builds crates/iroh-web-wasm with wasm-pack (bundler target) into ./pkg and
// shrinks the result with wasm-opt. Pass --dev for a fast unoptimised build.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgDir = resolve(here, '..')
const crateDir = resolve(pkgDir, '../../crates/iroh-web-wasm')
const outDir = resolve(pkgDir, 'pkg')
const dev = process.argv.includes('--dev')

// ring's C sources need a clang that can target wasm32; Apple clang cannot.
const llvmBin = '/opt/homebrew/opt/llvm/bin'
const env = { ...process.env }
if (existsSync(llvmBin)) {
  env.CC_wasm32_unknown_unknown ??= `${llvmBin}/clang`
  env.AR_wasm32_unknown_unknown ??= `${llvmBin}/llvm-ar`
}

function run(cmd, args) {
  console.log(`$ ${cmd} ${args.join(' ')}`)
  execFileSync(cmd, args, { stdio: 'inherit', env, cwd: crateDir })
}

run('wasm-pack', [
  'build',
  crateDir,
  dev ? '--dev' : '--release',
  '--target',
  'bundler',
  '--out-dir',
  outDir,
  '--out-name',
  'iroh_web_wasm',
  '--no-pack',
])

routeWebSocketsThroughRelayUrl(resolve(outDir, 'iroh_web_wasm_bg.js'))

// The only WebSockets the wasm opens are iroh relay connections. Pass each URL
// through relayWebSocketUrl (src/relay-websocket-url.ts) before the browser
// sees it. Fails the build if the glue no longer has the expected shape.
function routeWebSocketsThroughRelayUrl(gluePath) {
  const glue = readFileSync(gluePath, 'utf8')
  const constructor = /new WebSocket\((getStringFromWasm0\(arg0, arg1\))/g
  const routed = glue.replace(constructor, 'new WebSocket(relayWebSocketUrl($1)')
  const total = glue.split('new WebSocket(').length - 1
  const rewritten = routed.split('new WebSocket(relayWebSocketUrl(').length - 1
  if (total === 0 || rewritten !== total) {
    throw new Error(
      `${gluePath}: expected every \`new WebSocket(getStringFromWasm0(arg0, arg1)…)\` to be rewritten, ` +
        `rewrote ${rewritten} of ${total}. Update routeWebSocketsThroughRelayUrl for the new wasm-bindgen glue.`,
    )
  }
  const routedImport = "import { relayWebSocketUrl } from '../dist/relay-websocket-url.js'\n"
  writeFileSync(gluePath, routedImport + routed)
  console.log(`routed ${rewritten} WebSocket constructor(s) through relayWebSocketUrl`)
}

const wasmFile = resolve(outDir, 'iroh_web_wasm_bg.wasm')
if (!dev) {
  run('wasm-opt', [
    '-Oz',
    '--enable-bulk-memory',
    '--enable-nontrapping-float-to-int',
    '--enable-sign-ext',
    '--enable-mutable-globals',
    '-o',
    wasmFile,
    wasmFile,
  ])
}

const raw = statSync(wasmFile).size
const gz = gzipSync(readFileSync(wasmFile), { level: 9 }).length
const kib = (n) => `${(n / 1024).toFixed(0)} KiB`
console.log(`\n${wasmFile}\n  raw:  ${kib(raw)}\n  gzip: ${kib(gz)}`)

// Keep npm from excluding the generated wasm assets.
rmSync(resolve(outDir, '.gitignore'), { force: true })
