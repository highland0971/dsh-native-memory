#!/usr/bin/env node
// Static checks for the bundle patch before installing it on a real
// deployment:
//   node scripts/verify-bundle.mjs
//
// Parses cordis.patch.yml with the EXACT dialect the harness loader uses
// (js-yaml JSON_SCHEMA extended with the `!!js` expression node — see
// vendor/include/src/yaml.ts in the deepseek-harness checkout), then
// shape-checks the two entries.
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as yaml from 'js-yaml'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const isJsExpr = (data) => data !== null && typeof data === 'object' && typeof data.__jsExpr === 'string'
const JsExpr = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (data) => typeof data === 'string',
  construct: (data) => ({ __jsExpr: data }),
  predicate: isJsExpr,
  represent: (data) => data.__jsExpr,
})
const schema = yaml.JSON_SCHEMA.extend(JsExpr)

const doc = yaml.load(readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8'), { schema })

const failures = []
if (!Array.isArray(doc)) failures.push('cordis.patch.yml must be a top-level array of patch entries')

for (const entry of doc ?? []) {
  if (entry.id !== undefined) {
    if (entry.id === 'session-query-sqlite') {
      const c = entry.config ?? {}
      if (c.openAt !== 'first-search' && c.openAt !== 'startup') {
        failures.push('session-query-sqlite patch must set openAt to first-search or startup')
      }
      const path = c.path
      if (!(typeof path === 'string') && !(path?.__jsExpr)) {
        failures.push('session-query-sqlite patch must set a durable path (string or !!js expression)')
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
console.log('bundle patch checks passed (harness-loader dialect, static)')
