// Tool surface tests: the eight tools register into ctx.tools; write tools
// route through the approval gate (mocked) and fail closed; read tools never
// ask; caller workspace authorization enforced via exec.agent.session.header.cwd.
//
// The tool layer runs against the REAL memory domain (bootMemory) so these
// tests exercise the write pipeline end to end; only the approval stack and
// the session-query service are test doubles, exactly as the handoff asks.

import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'

import type { ApprovalGate } from '../src/approval.ts'
import type { ToolExec } from '../src/types.ts'
import { extractCandidateSentences, registerMemoryTools } from '../src/tools.ts'
import type { MemoryService } from '../src/tools.ts'
import { bootMemory, makeFact } from './helpers/harness.ts'
import type { MemoryHarness } from './helpers/harness.ts'

const WS = '/home/user/project'

interface RegisteredTool {
  readonly name: string
  readonly parameters: Record<string, unknown>
  execute(args: unknown, exec: ToolExec): Promise<unknown>
}

interface ToolBox {
  readonly defs: Map<string, RegisteredTool>
  /** How many times the effect disposer has run. */
  disposeCalls: number
}

/** A minimal fake ctx capturing registrations through ctx.effect. */
function fakeToolsCtx(): { ctx: Context; box: ToolBox } {
  const box: ToolBox = { defs: new Map(), disposeCalls: 0 }
  const ctx = {
    effect: (cb: () => () => void) => {
      // ctx.effect runs the body immediately and returns the disposer.
      const inner = cb()
      return () => {
        box.disposeCalls += 1
        inner()
      }
    },
    tools: {
      register: (definition: RegisteredTool) => {
        box.defs.set(definition.name, definition)
        return () => {
          box.defs.delete(definition.name)
        }
      },
    },
    logger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    get: () => undefined,
  }
  return { ctx: ctx as unknown as Context, box }
}

interface AskRecord {
  readonly toolName: string
  readonly agent: unknown
  readonly callId: unknown
  readonly reason: string
}

interface ToolKit {
  readonly box: ToolBox
  readonly harness: MemoryHarness
  readonly service: MemoryService
  readonly asks: AskRecord[]
  readonly searchImpl: ReturnType<typeof vi.fn>
  readonly readSessionImpl: ReturnType<typeof vi.fn>
}

async function toolkit(options: { allowed?: boolean; withSessionQuery?: boolean; config?: Record<string, unknown> } = {}): Promise<ToolKit> {
  const { ctx, box } = fakeToolsCtx()
  const harness = await bootMemory(options.config ?? {})
  const asks: AskRecord[] = []
  const gate: ApprovalGate = {
    request: vi.fn(async (req) => {
      asks.push({ toolName: req.toolName, agent: req.agent, callId: req.callId, reason: req.reason })
      return options.allowed ?? true
    }),
  }
  const searchImpl = vi.fn()
  const readSessionImpl = vi.fn()
  const service: MemoryService = {
    config: harness.config,
    storageDomainAvailable: true,
    getDomain: async () => harness.domain,
    openedDomain: () => harness.domain,
    ensureDomain: () => {},
    approvalGate: gate,
    sessionQuery: options.withSessionQuery === false ? undefined : { searchSessions: searchImpl, readSession: readSessionImpl },
  }
  registerMemoryTools(ctx, service)
  return { box, harness, service, asks, searchImpl, readSessionImpl }
}

function execFor(cwd: string | undefined = WS, events: readonly unknown[] = [1, 2, 3]): ToolExec {
  return {
    callId: 'call-1',
    agent: { session: { id: 'sess-tool', header: { cwd }, events } },
    signal: new AbortController().signal,
  }
}

async function call(box: ToolBox, name: string, args: unknown, exec: ToolExec): Promise<unknown> {
  const definition = box.defs.get(name)
  if (definition === undefined) throw new Error(`tool ${name} not registered`)
  return definition.execute(args, exec)
}

function expectMemoryError(promise: Promise<unknown>, code: string) {
  return expect(promise).rejects.toMatchObject({ name: 'MemoryError', code })
}

describe('memory tools', () => {
  it('registers all eight tools with their names', async () => {
    const { box } = await toolkit()
    expect([...box.defs.keys()].sort()).toEqual([
      'memory_consolidate',
      'memory_edit',
      'memory_forget',
      'memory_import',
      'memory_profile',
      'memory_recall',
      'memory_remember',
      'memory_search',
    ])
  })

  it('memory_remember asks the approval stack with the agent, call id, and a reason, then stores with provenance', async () => {
    const { box, harness, asks } = await toolkit()
    const exec = execFor()
    const result = await call(box, 'memory_remember', { text: 'uses tabs', kind: 'convention', tags: ['style'] }, exec)
    expect(String(result)).toContain('stored fact')
    expect(asks).toHaveLength(1)
    expect(asks[0]).toMatchObject({ toolName: 'memory_remember', agent: exec.agent, callId: 'call-1' })
    expect(asks[0]?.reason).toContain('uses tabs')

    const facts = harness.domain.listActive(WS)
    expect(facts).toHaveLength(1)
    expect(facts[0]).toMatchObject({
      workspacePath: WS,
      kind: 'convention',
      text: 'uses tabs',
      tags: ['style'],
      sessionId: 'sess-tool',
      seq: 3,
    })
  })

  it('memory_remember fails closed on a denied approval — nothing lands', async () => {
    const { box, harness, asks } = await toolkit({ allowed: false })
    await expectMemoryError(
      call(box, 'memory_remember', { text: 'should not land' }, execFor()),
      'MEMORY_APPROVAL_DENIED',
    )
    expect(asks).toHaveLength(1)
    expect(harness.domain.activeCount(WS)).toBe(0)
  })

  it('read tools never ask the approval gate', async () => {
    const { box, asks } = await toolkit()
    await call(box, 'memory_recall', { query: 'anything' }, execFor())
    await call(box, 'memory_profile', {}, execFor())
    expect(asks).toHaveLength(0)
  })

  it('memory_forget archives with approval; memory_edit replaces with approval', async () => {
    const { box, harness, asks } = await toolkit()
    await call(box, 'memory_remember', { text: 'old text', tags: ['a'] }, execFor())
    const id = harness.domain.listActive(WS)[0]?.id as string

    await call(box, 'memory_edit', { id, text: 'new text' }, execFor(WS, [1, 2, 3, 4]))
    expect(harness.domain.getFact(WS, id)).toMatchObject({ text: 'new text', tags: ['a'], seq: 4 })

    await call(box, 'memory_forget', { id }, execFor())
    expect(harness.domain.getFact(WS, id)?.state).toBe('archived')
    expect(harness.domain.listActive(WS)).toEqual([])
    expect(asks.map(ask => ask.toolName)).toEqual(['memory_remember', 'memory_edit', 'memory_forget'])
  })

  it('memory_edit and memory_forget reject unknown ids', async () => {
    const { box } = await toolkit()
    await expectMemoryError(call(box, 'memory_edit', { id: 'missing', text: 'x' }, execFor()), 'MEMORY_NOT_FOUND')
    await expectMemoryError(call(box, 'memory_forget', { id: 'missing' }, execFor()), 'MEMORY_NOT_FOUND')
  })

  it('memory_recall renders ranked facts and honors the query', async () => {
    const { box, harness } = await toolkit()
    await harness.domain.remember(makeFact({ workspacePath: WS, text: 'the ci pipeline', tags: [] }))
    await harness.domain.remember(makeFact({ workspacePath: WS, text: 'unrelated', tags: ['ci'] }))
    const result = await call(box, 'memory_recall', { query: 'ci' }, execFor())
    const text = String(result)
    expect(text).toContain('the ci pipeline')
    expect(text).toContain('unrelated')
    // Exact tag match (curated routing) outranks a text substring.
    expect(text.indexOf('unrelated')).toBeLessThan(text.indexOf('the ci pipeline'))
  })

  it('memory_search renders FTS hits and is workspace-filtered', async () => {
    const { box, searchImpl } = await toolkit()
    searchImpl.mockResolvedValueOnce({
      items: [{
        header: { id: 'past-session', createdAt: 1000 },
        bestMatch: { snippet: 'we decided to use pnpm' },
      }],
    })
    const result = await call(box, 'memory_search', { query: 'pnpm' }, execFor())
    expect(String(result)).toContain('past-session')
    expect(String(result)).toContain('we decided to use pnpm')
    expect(searchImpl).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'pnpm',
        sessionFilters: [{ kind: 'cwd', values: [WS] }],
        limit: 5,
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })

  it('memory_search excludes the calling session from its results', async () => {
    const { box, searchImpl } = await toolkit()
    searchImpl.mockResolvedValueOnce({
      items: [
        { header: { id: 'sess-tool', createdAt: 2000 }, bestMatch: { snippet: 'my own search call' } },
        { header: { id: 'past-session', createdAt: 1000 }, bestMatch: { snippet: 'we decided to use pnpm' } },
      ],
    })
    const result = await call(box, 'memory_search', { query: 'pnpm' }, execFor())
    expect(String(result)).toContain('past-session')
    expect(String(result)).not.toContain('sess-tool')
  })

  it('memory_search says no prior-session matches when only the caller matched', async () => {
    const { box, searchImpl } = await toolkit()
    searchImpl.mockResolvedValueOnce({
      items: [{ header: { id: 'sess-tool', createdAt: 2000 }, bestMatch: { snippet: 'self only' } }],
    })
    const result = await call(box, 'memory_search', { query: 'pnpm' }, execFor())
    expect(String(result)).toContain('no prior-session matches')
  })

  it('memory_search reports SESSION_QUERY_SEARCH_DISABLED when the backend refuses', async () => {
    const { box, searchImpl } = await toolkit()
    const disabled = new Error('search disabled')
    Object.assign(disabled, { code: 'SESSION_QUERY_SEARCH_DISABLED' })
    searchImpl.mockRejectedValueOnce(disabled)
    await expectMemoryError(call(box, 'memory_search', { query: 'x' }, execFor()), 'SESSION_QUERY_SEARCH_DISABLED')
  })

  it('memory_search fails closed without a session-query service', async () => {
    const { box } = await toolkit({ withSessionQuery: false })
    await expectMemoryError(call(box, 'memory_search', { query: 'x' }, execFor()), 'MEMORY_DISABLED')
  })

  it('requires an agent-bound, workspace-scoped caller', async () => {
    const { box } = await toolkit()
    const noAgent = { callId: 'c', signal: new AbortController().signal }
    await expectMemoryError(call(box, 'memory_recall', {}, noAgent), 'MEMORY_MISSING_AGENT')
    const noCwd = {
      callId: 'c',
      agent: { session: { id: 'sess-1', header: {}, events: [] } },
      signal: new AbortController().signal,
    }
    await expectMemoryError(call(box, 'memory_remember', { text: 'x' }, noCwd), 'MEMORY_UNAUTHORIZED')
  })

  it('memory_profile shows the profile and memory_remember target:profile rewrites it', async () => {
    const { box, harness, asks } = await toolkit()
    const empty = await call(box, 'memory_profile', {}, execFor())
    expect(String(empty)).toContain('0/8')

    await call(box, 'memory_remember', { text: 'release notes live in CHANGELOG', target: 'profile' }, execFor())
    await call(box, 'memory_remember', { text: 'docs are bilingual', target: 'profile' }, execFor())
    expect(harness.domain.getProfile(WS).entries).toEqual([
      'release notes live in CHANGELOG',
      'docs are bilingual',
    ])

    // Replace entry 0, drop entry 1.
    await call(box, 'memory_remember', { text: 'release notes live in CHANGELOG.md', target: 'profile', profile_index: 0 }, execFor())
    await call(box, 'memory_remember', { text: '', target: 'profile', profile_index: 1 }, execFor())
    expect(harness.domain.getProfile(WS).entries).toEqual(['release notes live in CHANGELOG.md'])

    const shown = await call(box, 'memory_profile', {}, execFor())
    expect(String(shown)).toContain('release notes live in CHANGELOG.md')
    expect(asks.filter(ask => ask.toolName === 'memory_remember')).toHaveLength(4)
  })

  it('caps are pre-checked BEFORE the approval ask — the gate is never called for doomed writes', async () => {
    const { box, harness, asks } = await toolkit({
      config: { maxFactsPerWorkspace: 2, maxProfileEntryChars: 10 },
    })
    // Oversized fact text: rejected without an approval ask.
    await expectMemoryError(
      call(box, 'memory_remember', { text: 'x'.repeat(3000) }, execFor()),
      'MEMORY_CAP_EXCEEDED',
    )
    // Workspace at its fact cap: a NEW fact is rejected without an ask…
    await call(box, 'memory_remember', { text: 'a' }, execFor())
    await call(box, 'memory_remember', { text: 'b' }, execFor())
    expect(harness.domain.activeCount(WS)).toBe(2)
    await expectMemoryError(
      call(box, 'memory_remember', { text: 'c' }, execFor()),
      'MEMORY_CAP_EXCEEDED',
    )
    // …but an UPDATE of an existing id still works (asks once more).
    const id = harness.domain.listActive(WS)[0]?.id as string
    await call(box, 'memory_remember', { id, text: 'a-updated' }, execFor())
    expect(harness.domain.getFact(WS, id)?.text).toBe('a-updated')
    // Oversized profile entry: rejected without an ask.
    await expectMemoryError(
      call(box, 'memory_remember', { text: 'y'.repeat(300), target: 'profile' }, execFor()),
      'MEMORY_CAP_EXCEEDED',
    )
    // Only the APPROVED writes (a, b) and the approved update asked; the
    // three doomed writes above never reached the gate.
    expect(asks.filter(ask => ask.toolName === 'memory_remember')).toHaveLength(3)
  })

  it('invalid arguments become MEMORY_INVALID_ARGS', async () => {
    const { box } = await toolkit()
    await expectMemoryError(call(box, 'memory_remember', { text: '' }, execFor()), 'MEMORY_INVALID_ARGS')
    await expectMemoryError(call(box, 'memory_edit', { id: 'x' }, execFor()), 'MEMORY_INVALID_ARGS')
  })

  it('memory_consolidate suggests merges and reports the budget without asking', async () => {
    const { box, harness, asks } = await toolkit()
    await harness.domain.remember(makeFact({ workspacePath: WS, text: 'release verification runs from the web session' }))
    await harness.domain.remember(makeFact({ workspacePath: WS, text: 'release verification runs in the web session' }))
    const result = await call(box, 'memory_consolidate', {}, execFor())
    const text = String(result)
    expect(text).toContain('2 active facts; budget remaining:')
    expect(text).toContain('Merge candidates')
    expect(text).toContain('%')
    expect(asks).toHaveLength(0)
  })

  it('extractCandidateSentences keeps only matching sentences', () => {
    const text = 'we decided to use pnpm. later we used npm. the build runs with pnpm test.'
    const hits = extractCandidateSentences(text, 'pnpm')
    expect(hits).toEqual(['we decided to use pnpm.', 'the build runs with pnpm test.'])
    expect(extractCandidateSentences(text, 'yarn')).toEqual([])
  })

  it('memory_import asks per candidate and stores facts with the source session provenance', async () => {
    const { box, harness, asks, readSessionImpl } = await toolkit()
    readSessionImpl.mockResolvedValueOnce({
      session: { id: 'past-sess', cwd: WS },
      events: [
        { type: 'user/message', seq: 10, data: { message: { content: [{ type: 'text', text: 'we decided to use pnpm. later we used npm.' }] } } },
        { type: 'assistant/message', seq: 11, data: { message: { content: [{ type: 'text', text: 'the build runs with pnpm test.' }] } } },
      ],
    })
    const result = await call(box, 'memory_import', { session_id: 'past-sess', query: 'pnpm', kind: 'decision' }, execFor())
    expect(String(result)).toContain('imported 2 fact(s) from session past-sess')
    expect(asks.filter(ask => ask.toolName === 'memory_import')).toHaveLength(2)
    const facts = harness.domain.listActive(WS)
    expect(facts).toHaveLength(2)
    expect(facts.map(fact => fact.sessionId)).toEqual(['past-sess', 'past-sess'])
    expect(facts.map(fact => fact.seq).sort()).toEqual([10, 11])
    expect(facts.every(fact => fact.kind === 'decision')).toBe(true)
  })

  it('memory_import skips denied candidates and reports none imported', async () => {
    const { box, harness, readSessionImpl } = await toolkit({ allowed: false })
    readSessionImpl.mockResolvedValueOnce({
      session: { id: 'past-sess', cwd: WS },
      events: [{ type: 'assistant/message', seq: 5, data: { message: { content: [{ type: 'text', text: 'we use pnpm here.' }] } } }],
    })
    const result = await call(box, 'memory_import', { session_id: 'past-sess', query: 'pnpm' }, execFor())
    expect(String(result)).toContain('none of the 1 candidates were approved')
    expect(harness.domain.activeCount(WS)).toBe(0)
  })

  it('memory_import enforces exact-cwd authorization and rejects the calling session', async () => {
    const { box, readSessionImpl } = await toolkit()
    readSessionImpl.mockResolvedValueOnce({ session: { id: 'foreign', cwd: '/elsewhere' }, events: [] })
    await expectMemoryError(
      call(box, 'memory_import', { session_id: 'foreign', query: 'x' }, execFor()),
      'MEMORY_UNAUTHORIZED',
    )
    await expectMemoryError(
      call(box, 'memory_import', { session_id: 'sess-tool', query: 'x' }, execFor()),
      'MEMORY_INVALID_ARGS',
    )
  })

  it('disposing the effect unregisters the tools', async () => {
    const { ctx, box } = fakeToolsCtx()
    const harness = await bootMemory()
    const disposer = registerMemoryTools(ctx, {
      config: harness.config,
      storageDomainAvailable: true,
      getDomain: async () => harness.domain,
      openedDomain: () => harness.domain,
      ensureDomain: () => {},
      approvalGate: { request: async () => true },
      sessionQuery: undefined,
    })
    expect(box.defs.size).toBe(8)
    disposer()
    expect(box.defs.size).toBe(0)
    expect(box.disposeCalls).toBe(1)
  })
})
