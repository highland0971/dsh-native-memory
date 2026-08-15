// Session-end memory proposal tests: the hook registers only when enabled;
// a disposed session is distilled with one LLM call into PENDING proposals
// (masked, workspace-scoped, provenance kept) that never become facts on
// their own; missing llm / bad output / headless cwd degrade silently.

import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'

import { registerSessionEndProposal } from '../src/propose.ts'
import type { MemoryService } from '../src/tools.ts'
import { bootMemory } from './helpers/harness.ts'
import type { MemoryHarness } from './helpers/harness.ts'

const WS = '/home/user/project'

interface LlmCall {
  readonly messages: ReadonlyArray<{ readonly content: ReadonlyArray<{ readonly text: string }> }>
  readonly maxTokens?: number
}

interface PreparedLike {
  readonly config: {
    readonly provider: string
    readonly model: string
    readonly reasoningEffort: string
    readonly maxTokens?: number
    readonly temperature?: number
  }
  readonly stream: (options: {
    readonly provider: string
    readonly model: string
    readonly reasoningEffort?: string
    readonly messages: LlmCall['messages']
    readonly maxTokens?: number
  }) => AsyncIterable<{ readonly type: string; readonly text?: string }>
}

type PrepareCall = (config: { provider: string; model: string; maxTokens?: number; temperature?: number }) => Promise<PreparedLike>

function fakeLlm(outputs: string[]): { prepareCall: PrepareCall & ReturnType<typeof vi.fn>; calls: LlmCall[] } {
  const calls: LlmCall[] = []
  const prepareCall = vi.fn<PrepareCall>(async (config) => {
    // The real runtime materializes adapter defaults (DeepSeek always folds a
    // reasoningEffort into the prepared config) and stream() enforces exact
    // equality with that materialized config — INVALID_PREPARED_CALL on any
    // mismatch. The mock replicates both so a regression is caught by tests.
    const materialized = { ...config, reasoningEffort: 'off' as string }
    return {
      config: materialized,
      stream: async function* (options) {
        if (options.provider !== materialized.provider
          || options.model !== materialized.model
          || options.reasoningEffort !== materialized.reasoningEffort) {
          throw new Error('INVALID_PREPARED_CALL')
        }
        calls.push({ messages: options.messages, maxTokens: options.maxTokens })
        for (const text of outputs) yield { type: 'text-delta', text }
        yield { type: 'finish' }
      },
    }
  })
  return { prepareCall, calls }
}

function proposalCtx(listeners: Map<string, Array<(payload: unknown) => void>>, llm?: unknown): Context {
  const ctx = {
    on: (name: string, cb: (payload: unknown) => void) => {
      const list = listeners.get(name) ?? []
      list.push(cb)
      listeners.set(name, list)
    },
    get: (name: string) => (name === 'llm' ? llm : undefined),
    effect: (cb: () => () => void) => cb(),
  }
  return ctx as unknown as Context
}

function proposalService(harness: MemoryHarness): MemoryService {
  return {
    config: harness.config,
    storageDomainAvailable: true,
    getDomain: async () => harness.domain,
    openedDomain: () => harness.domain,
    ensureDomain: () => {},
    approvalGate: { request: async () => true },
    sessionQuery: undefined,
  }
}

interface DisposedFixture {
  readonly id: string
  readonly header?: { readonly cwd?: string }
  readonly events?: readonly unknown[]
}

describe('session-end proposals', () => {
  it('the mock enforces the prepared-config equality contract', async () => {
    const llm = fakeLlm(['[]'])
    const prepared = await llm.prepareCall({ provider: 'deepseek', model: 'deepseek-v4-flash' })
    await expect(async () => {
      for await (const _chunk of prepared.stream({
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        reasoningEffort: 'max',
        messages: [],
      })) {
        // never reached
      }
    }).rejects.toThrow('INVALID_PREPARED_CALL')
  })

  it('registers nothing when proposeOnSessionEnd is off (the default)', async () => {
    const harness = await bootMemory()
    const listeners = new Map<string, Array<(payload: unknown) => void>>()
    const ctx = proposalCtx(listeners)
    expect(registerSessionEndProposal(ctx, proposalService(harness))).toBeUndefined()
    expect(listeners.get('session/disposed')).toBeUndefined()
  })

  it('distills a disposed session into pending proposals with provenance and masked secrets', async () => {
    const harness = await bootMemory({ proposeOnSessionEnd: true })
    const listeners = new Map<string, Array<(payload: unknown) => void>>()
    const llm = fakeLlm([`["we use pnpm for builds","the push token is ghp_${'a'.repeat(36)}"]`])
    const ctx = proposalCtx(listeners, { prepareCall: llm.prepareCall })
    registerSessionEndProposal(ctx, proposalService(harness))

    const disposed: DisposedFixture = {
      id: 'sess-old',
      header: { cwd: WS },
      events: [
        { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: 'we use pnpm for builds.' }] } },
        { type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'text', text: `the push token is ghp_${'a'.repeat(36)}` }] } } },
      ],
    }
    listeners.get('session/disposed')?.[0]?.(disposed)

    await vi.waitFor(() => {
      expect(harness.domain.pendingProposals(WS)).toHaveLength(2)
    })
    const pending = harness.domain.pendingProposals(WS)
    expect(pending.map(proposal => proposal.sessionId)).toEqual(['sess-old', 'sess-old'])
    expect(pending.every(proposal => proposal.state === 'pending')).toBe(true)
    const masked = pending.find(proposal => proposal.text.includes('push token'))
    expect(masked?.text).toContain('[REDACTED]')
    expect(masked?.text).not.toContain('ghp_')
    // Exactly one LLM call, one bounded one-shot user message.
    expect(llm.prepareCall).toHaveBeenCalledTimes(1)
    expect(llm.calls).toHaveLength(1)
    expect(llm.calls[0]?.messages).toHaveLength(1)
    expect(llm.calls[0]?.messages[0]?.content[0]?.text).toContain('we use pnpm for builds')
    expect(llm.calls[0]?.maxTokens).toBe(1024)
  })

  it('skips silently without llm, without a workspace cwd, or on unparsable output', async () => {
    const harness = await bootMemory({ proposeOnSessionEnd: true })

    // No llm service: nothing happens.
    const listeners = new Map<string, Array<(payload: unknown) => void>>()
    const ctx = proposalCtx(listeners, undefined)
    registerSessionEndProposal(ctx, proposalService(harness))
    listeners.get('session/disposed')?.[0]?.({
      id: 'sess-x',
      header: { cwd: WS },
      events: [{ type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: 'hello' }] } }],
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(harness.domain.pendingProposals(WS)).toEqual([])

    // llm present but output unparsable: no proposals, no crash.
    const llm = fakeLlm(['not json at all'])
    const listeners2 = new Map<string, Array<(payload: unknown) => void>>()
    registerSessionEndProposal(proposalCtx(listeners2, { prepareCall: llm.prepareCall }), proposalService(harness))
    listeners2.get('session/disposed')?.[0]?.({
      id: 'sess-bad',
      header: { cwd: WS },
      events: [{ type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: 'hello' }] } }],
    })
    await vi.waitFor(() => expect(llm.prepareCall).toHaveBeenCalledTimes(1))
    expect(harness.domain.pendingProposals(WS)).toEqual([])

    // Headless session (no cwd): skipped BEFORE any llm call.
    const listeners3 = new Map<string, Array<(payload: unknown) => void>>()
    registerSessionEndProposal(proposalCtx(listeners3, { prepareCall: llm.prepareCall }), proposalService(harness))
    listeners3.get('session/disposed')?.[0]?.({
      id: 'sess-h',
      header: {},
      events: [{ type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: 'hello' }] } }],
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(llm.prepareCall).toHaveBeenCalledTimes(1)
  })

  it('enforces the pending cap: oldest pendings expire first', async () => {
    const harness = await bootMemory({ proposeOnSessionEnd: true, proposalMaxPending: 2 })
    const day = 86_400_000
    const now = Date.now()
    const mk = (id: string, createdAt: number) => harness.domain.addProposal({
      id,
      workspacePath: WS,
      text: `proposal ${id}`,
      sessionId: 'sess-old',
      createdAt,
      state: 'pending',
    })
    await mk('p1', now - 2 * day)
    await mk('p2', now - day)
    await mk('p3', now)
    expect(harness.domain.pendingProposals(WS).map(proposal => proposal.id)).toEqual(['p2', 'p3'])
  })

  it('proposals expire by ttl and consume on normalized text match', async () => {
    const harness = await bootMemory()
    const day = 86_400_000
    await harness.domain.addProposal({ id: 'stale', workspacePath: WS, text: 'stale note', sessionId: 's', createdAt: Date.now() - 8 * day, state: 'pending' })
    await harness.domain.addProposal({ id: 'fresh', workspacePath: WS, text: 'use   tabs', sessionId: 's', createdAt: Date.now(), state: 'pending' })
    expect(harness.domain.pendingProposals(WS).map(proposal => proposal.id)).toEqual(['fresh'])
    await harness.domain.consumeProposal(WS, 'use tabs')
    expect(harness.domain.pendingProposals(WS)).toEqual([])
  })
})
