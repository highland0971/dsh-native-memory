// Client module handoff shape test: the browser client fiber reads name and
// inject from the MODULE EXPORT of the classic script — a missing
// inject: ['slots'] makes the settings page silently never register. This
// executes src/client.js against a stubbed window.__ModuleLoader__ and
// asserts the handoff shape.

import { describe, expect, it, vi } from 'vitest'

interface Handoff {
  id: string
  exports: Record<string, unknown>
}

describe('client module handoff', () => {
  it('exports name, apply, and inject:["slots"] for the client fiber', async () => {
    const captured: Partial<Handoff> = {}
    const load = vi.fn((entry: { id: string; factory: (require: (name: string) => unknown) => Record<string, unknown> }) => {
      captured.id = entry.id
      const require = (name: string) => {
        if (name === 'react') return {}
        throw new Error(`unexpected require(${name}) in shape test`)
      }
      captured.exports = entry.factory(require)
    })
    const g = globalThis as unknown as { window?: unknown }
    g.window = { __ModuleLoader__: { load } }
    const clientUrl = new URL('../src/client.js', import.meta.url).href
    try {
      // Variable-specifier import: the classic script has no declarations,
      // and vitest executes it as a side-effect module against the stub.
      await import(clientUrl)
    } finally {
      delete g.window
    }
    expect(load).toHaveBeenCalledTimes(1)
    expect(captured.id).toBe('dsh-native-memory')
    expect(captured.exports?.name).toBe('dsh-native-memory')
    expect(captured.exports?.inject).toEqual(['slots'])
    expect(typeof captured.exports?.apply).toBe('function')
  })
})
