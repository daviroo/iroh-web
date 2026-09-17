import { copyFileSync } from 'node:fs'

for (const name of ['README.md', 'LICENSE-MIT', 'LICENSE-APACHE']) {
  copyFileSync(new URL(`../../../${name}`, import.meta.url), new URL(`../${name}`, import.meta.url))
}
