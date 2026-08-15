// Copies the classic-script client half into lib/ beside the host ESM build.
// src/client.js must stay a plain classic script — the harness executes it
// through its browser client module loader — so it is authored in plain
// JavaScript and copied verbatim; tsdown never bundles it.
import { copyFileSync, mkdirSync } from 'node:fs'

const root = new URL('..', import.meta.url)
mkdirSync(new URL('lib', root), { recursive: true })
copyFileSync(new URL('src/client.js', root), new URL('lib/client.js', root))
console.log('copied src/client.js -> lib/client.js')
