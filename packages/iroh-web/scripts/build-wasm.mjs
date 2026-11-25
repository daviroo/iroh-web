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

routeRequestUrls(resolve(outDir, 'iroh_web_wasm_bg.js'))

// Every network request the wasm makes (relay WebSockets, the relay latency
// probe, pkarr lookups) passes its URL through requestUrl
// (src/request-url.ts) before the browser sees it. `fetch` in the glue only
// takes Request objects, so routing `new Request` covers it. Fails the build
// if any call that can carry a URL is left unrouted, for example after a
// wasm-bindgen upgrade or a new dependency.
function routeRequestUrls(gluePath) {
  const glue = readFileSync(gluePath, 'utf8')
  const routed = glue.replace(
    /new (WebSocket|Request)\((getStringFromWasm0\(arg0, arg1\))/g,
    'new $1(requestUrl($2)',
  )
  const unrouted = [
    [/new (?:WebSocket|Request)\((?!requestUrl\()/g, 'WebSocket or Request constructor'],
    [/\bfetch\((?!getObject\(arg[01]\)\))/g, 'fetch with a URL argument'],
    [/new EventSource\(|new XMLHttpRequest\(|sendBeacon\(|new Worker\(|new SharedWorker\(/g, 'other URL-taking call'],
  ].flatMap(([pattern, what]) => [...routed.matchAll(pattern)].map((m) => `${what} at offset ${m.index}: ${routed.slice(m.index, m.index + 80)}`))
  const count = routed.split('(requestUrl(').length - 1
  if (unrouted.length > 0 || count === 0) {
    throw new Error(
      `${gluePath}: every URL passed to the browser must go through requestUrl; ` +
        `routed ${count}, unrouted:\n${unrouted.join('\n')}\nUpdate routeRequestUrls for the new glue.`,
    )
  }
  writeFileSync(gluePath, "import { requestUrl } from '../dist/request-url.js'\n" + routed)
  console.log(`routed ${count} WebSocket/Request URL(s) through requestUrl`)
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
