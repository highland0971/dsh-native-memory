#!/usr/bin/env node
// Quick static checks for the bundle patch before installing it on a real
// deployment:
//   node scripts/verify-bundle.mjs
// Parses cordis.patch.yml, checks the two entries' shape, and verifies the
// plugin row references a resolvable package specifier.
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const doc = parseYaml(readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8'))

const failures = []
if (!Array.isArray(doc)) failures.push('cordis.patch.yml must be a top-level array of patch entries')

for (const entry of doc ?? []) {
  if (entry.id !== undefined) {
    // id-targeted config override — fine.
    if (entry.id === 'session-query-sqlite') {
      const c = entry.config ?? {}
      if (c.openAt !== 'first-search' && c.openAt !== 'startup') {
        failures.push('session-query-sqlite patch must set openAt to first-search or startup')
      }
      if (typeof c.path !== 'string' || c.path === '') {
        failures.push('session-query-sqlite patch must set a durable path (path is !!js, string check is loose)')
      }
    }
  } else if (entry.insert !== undefined) {
    for (const row of entry.insert) {
      if (row.id === 'dsh-native-memory' && row.name !== 'dsh-native-memory') {
        failures.push(`plugin row name must be the package specifier, got ${row.name}`)
      }
    }
  } else {
    failures.push(`unrecognized patch entry shape: ${JSON.stringify(entry)}`)
  }
}

if (failures.length > 0) {
  console.error('bundle patch checks FAILED:')
  for (const f of failures) console.error(' -', f)
  process.exit(1)
}
console.log('bundle patch checks passed (static)')
