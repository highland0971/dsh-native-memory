// Compaction drift guard tests: anchor extraction is deterministic and
// distinctive; a compaction/summary event whose summary dropped anchors
// records a bounded alarm with provenance and range; unrelated events and
// fully-covered summaries are ignored; disabled-by-config, missing cwd, and
// an unavailable sessionQuery degrade observably (issue #39 ported the
// shadowed-event read to ctx.sessionQuery.readSession).

import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'

import { extractAnchors, registerCompactionGuard, vanishedAnchors } from '../src/guard.ts'
import type { MemoryService } from '../src/tools.ts'
import type { SessionEventLike } from '../src/types.ts'
import { bootMemory } from './helpers/harness.ts'
import type { MemoryHarness } from './helpers/harness.ts'

const WS = '/home/user/project'

function guardCtx(
  listeners: Map<string, Array<(session: unknown, event: unknown) => void>>,
  warn = vi.fn(),
): Context {
  const ctx = {
    on: (name: string, cb: (session: unknown, event: unknown) => void) => {
      const list = listeners.get(name) ?? []
      list.push(cb)
      listeners.set(name, list)
    },
    get: () => undefined,
    effect: (cb: () => () => void) => cb(),
    logger: () => ({ warn }),
  }
  return ctx as unknown as Context
}

/** The guard now reads shadowed turns through readSession (live-preferred). */
function guardService(
  harness: MemoryHarness,
  eventsBySession: Record<string, readonly SessionEventLike[]> = {},
  readSessionImpl?: (sessionId: string) => Promise<never>,
): MemoryService {
  return {
    config: harness.config,
    storageDomainAvailable: true,
    getDomain: async () => harness.domain,
    openedDomain: () => harness.domain,
    ensureDomain: () => {},
    approvalGate: { request: async () => true },
    sessionQuery: {
      searchSessions: async () => ({ items: [] }),
      readSession:
        readSessionImpl ??
        (async (sessionId: string) => ({
          session: { id: sessionId },
          events: eventsBySession[sessionId] ?? [],
        })),
    },
  }
}

/** One compaction/summary event whose summary is ContentBlock[] on the wire. */
function summaryEvent(text: string, shadowedSeqs: readonly number[], range?: { start: number; end: number }) {
  return {
    type: 'compaction/summary',
    data: {
      summary: [{ type: 'text', text }],
      shadowedSeqs,
      ...(range === undefined ? {} : { shadowedRange: range }),
    },
  }
}

describe('extractAnchors', () => {
  it('keeps quoted literals, paths, key=value pairs and error tokens', () => {
    const text = 'the fix sets "pnpm config store-dir" in /home/user/.npmrc and PORT=3000; got ENOENT first.'
    const anchors = extractAnchors(text)
    expect(anchors).toContain('pnpm config store-dir')
    expect(anchors).toContain('/home/user/.npmrc')
    expect(anchors).toContain('PORT=3000')
    expect(anchors).toContain('ENOENT')
  })

  it('drops prose and stopword-only candidates', () => {
    expect(extractAnchors('this is just a sentence about nothing technical')).toEqual([])
    expect(extractAnchors('please "here" now')).toEqual([])
  })

  it('sorts longest first and dedupes', () => {
    const anchors = extractAnchors('the "alpha-beta gamma" and "alpha-beta gamma" plus "alpha-beta"')
    expect(anchors).toEqual(['alpha-beta gamma', 'alpha-beta'])
  })
})

describe('vanishedAnchors', () => {
  it('keeps only anchors missing from the summary, case-insensitively', () => {
    const anchors = ['/home/user/.npmrc', 'PORT=3000', 'ENOENT']
    expect(vanishedAnchors(anchors, 'the summary mentions port=3000 and /home/user/.npmrc')).toEqual(['ENOENT'])
    expect(vanishedAnchors(anchors, 'summary covers /home/user/.npmrc, port=3000, and the ENOENT fix')).toEqual([])
  })
})

describe('compaction guard registration', () => {
  it('is disabled by config', async () => {
    const harness = await bootMemory({ compactionGuard: false })
    const listeners = new Map<string, Array<(session: unknown, event: unknown) => void>>()
    expect(registerCompactionGuard(guardCtx(listeners), guardService(harness))).toBeUndefined()
    expect(listeners.get('session/event')).toBeUndefined()
  })

  it('records an alarm when the summary drops anchors, with provenance and range', async () => {
    const harness = await bootMemory()
    const listeners = new Map<string, Array<(session: unknown, event: unknown) => void>>()
    registerCompactionGuard(
      guardCtx(listeners),
      guardService(harness, {
        'sess-compact': [
          { type: 'user/message', seq: 10, data: { content: [{ type: 'text', text: 'the fix sets "pnpm config store-dir" and PORT=3000.' }] } },
          { type: 'assistant/message', seq: 11, data: { message: { content: [{ type: 'text', text: 'restart needed after change.' }] } } },
          { type: 'tool/result', seq: 12, data: { message: { role: 'tool', content: [{ type: 'text', text: 'exit 0' }] } } },
        ],
      }),
    )

    listeners.get('session/event')?.[0]?.(
      { id: 'sess-compact', header: { cwd: WS } },
      summaryEvent('the session tuned the pnpm store dir; nothing else matters.', [10, 11, 12], { start: 10, end: 12 }),
    )

    await vi.waitFor(() => {
      expect(harness.domain.activeAlarms(WS)).toHaveLength(1)
    })
    const alarm = harness.domain.activeAlarms(WS)[0]!
    expect(alarm.sessionId).toBe('sess-compact')
    expect(alarm.shadowedRange).toEqual({ start: 10, end: 12 })
    expect(alarm.vanishedAnchors).toContain('pnpm config store-dir')
    expect(alarm.vanishedAnchors).toContain('PORT=3000')
    expect(alarm.state).toBe('active')
  })

  it('ignores unrelated events and fully-covered summaries', async () => {
    const harness = await bootMemory()
    const listeners = new Map<string, Array<(session: unknown, event: unknown) => void>>()
    registerCompactionGuard(
      guardCtx(listeners),
      guardService(harness, {
        s: [{ type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: 'the token is PORT=3000' }] } }],
        h: [{ type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: 'PORT=3000' }] } }],
      }),
    )
    const fire = (session: unknown, event: unknown) => listeners.get('session/event')?.[0]?.(session, event)

    fire({ id: 's', header: { cwd: WS } }, { type: 'user/message', data: {} })
    fire({ id: 's', header: { cwd: WS } }, summaryEvent('we fixed the PORT=3000 issue.', [1]))
    // headless session (no cwd) even with vanished anchors
    fire({ id: 'h', header: {} }, summaryEvent('unrelated.', [1]))
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(harness.domain.activeAlarms(WS)).toEqual([])
  })

  it('derives anchors from tool-result messages and masks secrets before storage', async () => {
    const harness = await bootMemory()
    const listeners = new Map<string, Array<(session: unknown, event: unknown) => void>>()
    registerCompactionGuard(
      guardCtx(listeners),
      guardService(harness, {
        'sess-tool': [
          { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: `use token "${`ghp_${'a'.repeat(36)}`}" for pushes` }] } },
          { type: 'tool/result', seq: 2, data: { message: { role: 'tool', content: [{ type: 'text', text: 'ERR_MODULE_NOT_FOUND' }] } } },
        ],
      }),
    )
    listeners.get('session/event')?.[0]?.(
      { id: 'sess-tool', header: { cwd: WS } },
      summaryEvent('the module failed to load; nothing else.', [1, 2]),
    )
    await vi.waitFor(() => {
      expect(harness.domain.activeAlarms(WS)).toHaveLength(1)
    })
    const alarm = harness.domain.activeAlarms(WS)[0]!
    // The tool-result message's error token is a vanished anchor…
    expect(alarm.vanishedAnchors).toContain('ERR_MODULE_NOT_FOUND')
    // …and the quoted secret anchor was masked BEFORE storage.
    expect(alarm.vanishedAnchors.some(anchor => anchor.includes('[REDACTED]'))).toBe(true)
    expect(alarm.vanishedAnchors.some(anchor => anchor.includes('ghp_'))).toBe(false)
  })

  it('degrades observably when sessionQuery is unavailable (never silently)', async () => {
    const harness = await bootMemory()
    const listeners = new Map<string, Array<(session: unknown, event: unknown) => void>>()
    const warn = vi.fn()
    const service = guardService(harness)
    registerCompactionGuard(guardCtx(listeners, warn), { ...service, sessionQuery: undefined })

    listeners.get('session/event')?.[0]?.(
      { id: 'sess-x', header: { cwd: WS } },
      summaryEvent('the summary dropped everything.', [1]),
    )
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalled()
    })
    expect(String(warn.mock.calls[0]?.[0])).toContain('sessionQuery is unavailable')
    expect(harness.domain.activeAlarms(WS)).toEqual([])
  })

  it('contains a readSession failure without disturbing the session', async () => {
    const harness = await bootMemory()
    const listeners = new Map<string, Array<(session: unknown, event: unknown) => void>>()
    const warn = vi.fn()
    registerCompactionGuard(
      guardCtx(listeners, warn),
      guardService(harness, {}, async () => {
        throw new Error('persistence offline')
      }),
    )

    listeners.get('session/event')?.[0]?.(
      { id: 'sess-y', header: { cwd: WS } },
      summaryEvent('the summary dropped everything.', [1]),
    )
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalled()
    })
    expect(String(warn.mock.calls[0]?.[0])).toContain('persistence offline')
    expect(harness.domain.activeAlarms(WS)).toEqual([])
  })

  it('enforces the active alarm cap and ttl', async () => {
    const harness = await bootMemory({ guardAlarmMax: 2, guardAlarmTtlHours: 24 })
    const hour = 3_600_000
    const mk = (id: string, createdAt: number) => harness.domain.addAlarm({
      id,
      workspacePath: WS,
      sessionId: 's',
      vanishedAnchors: [`anchor-${id}`],
      createdAt,
      state: 'active',
    })
    await mk('a1', Date.now() - 2 * hour)
    await mk('a2', Date.now() - hour)
    await mk('a3', Date.now())
    expect(harness.domain.activeAlarms(WS).map(alarm => alarm.id)).toEqual(['a3', 'a2'])
    const stale = await bootMemory({ guardAlarmTtlHours: 24 })
    await stale.domain.addAlarm({
      id: 'old',
      workspacePath: WS,
      sessionId: 's',
      vanishedAnchors: ['anchor-old'],
      createdAt: Date.now() - 25 * hour,
      state: 'active',
    })
    expect(stale.domain.activeAlarms(WS)).toEqual([])
  })
})
