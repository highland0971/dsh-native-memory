// Config tests: defaults apply; the cross-field freshness constraint
// (fresh ≤ stale) rejects misconfigurations loudly.

import { describe, expect, it } from 'vitest'

import { Config } from '../src/config.ts'

describe('config', () => {
  it('applies defaults', () => {
    const config = Config.parse({})
    expect(config.recallFreshWindowDays).toBe(7)
    expect(config.recallStaleWindowDays).toBe(90)
    expect(config.secretPolicy).toBe('reject')
    expect(config.proposeOnSessionEnd).toBe(false)
    expect(config.compactionGuard).toBe(true)
  })

  it('rejects fresh window > stale window (unreachable intermediate tier)', () => {
    expect(() => Config.parse({ recallFreshWindowDays: 100, recallStaleWindowDays: 90 })).toThrow(
      'recallFreshWindowDays must be ≤ recallStaleWindowDays',
    )
    expect(() => Config.parse({ recallFreshWindowDays: 90, recallStaleWindowDays: 90 })).not.toThrow()
  })
})
