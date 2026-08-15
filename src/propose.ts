// Session-end memory proposal (v0.3.0, opt-in via proposeOnSessionEnd).
//
// On `session/disposed` (packages/session/session-persistence/src/coordinator.ts
// ctx.on('session/disposed')), one bounded transcript is distilled with ONE
// cheap LLM call into candidate facts. The candidates are PROPOSALS only:
// they land in the domain's proposals table (pending) and are rendered in the
// next sessions' prompt; they become facts only through memory_remember,
// whose approval gate does the human check — the LLM proposes, the human
// approves (the user's半自动 stance, unlocked for proposal but never for
// writes). No approval is needed to STORE a proposal: it is not memory
// content yet (recall and the profile never see it), and its text is masked
// before storage.
//
// LLM contract (packages/llm/llm/src/index.ts): ctx.llm.prepareCall(config)
// → { stream(options) }. The DeepSeek adapter serializes messages by role
// and content only (packages/llm/llm-deepseek/src/serialize.ts), so the
// messages below are structural — { id, role, content, source } — without
// importing the harness package (this plugin's zero-runtime-import rule).

import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'

import { maskSecrets } from './redaction.ts'
import { eventText } from './tools.ts'
import type { MemoryService } from './tools.ts'
import type { SessionEventLike } from './types.ts'
/** Upper bound on the transcript fed to the distiller (tail kept). */
export const PROPOSAL_TRANSCRIPT_MAX_CHARS = 16_000
/** How many pending proposals the prompt shows at most. */
export const PROPOSAL_DISPLAY_MAX = 3
/** Upper bound on one rendered proposal line in the prompt. */
export const PROPOSAL_DISPLAY_CHARS = 400

/** Structural view of the llm runtime surface we use. */
export interface LlmRuntimeLike {
  prepareCall(
    config: { readonly provider: string; readonly model: string; readonly maxTokens?: number; readonly temperature?: number },
    signal?: AbortSignal,
  ): Promise<{
    /**
     * The MATERIALIZED config (adapter defaults folded in — e.g. DeepSeek
     * always materializes a reasoningEffort). LlmRuntime.stream enforces
     * callConfigEquals(options, prepared.config) and throws
     * INVALID_PREPARED_CALL on any mismatch, so callers MUST spread this
     * back into the stream options (packages/llm/llm/src/index.ts:779-813).
     */
    readonly config: {
      readonly provider: string
      readonly model: string
      readonly reasoningEffort?: string
      readonly temperature?: number
      readonly maxTokens?: number
      readonly stop?: readonly string[]
    }
    stream(options: {
      readonly provider: string
      readonly model: string
      readonly reasoningEffort?: string
      readonly messages: ReadonlyArray<{
        readonly id: string
        readonly role: 'user' | 'assistant' | 'system'
        readonly content: ReadonlyArray<{ readonly type: 'text'; readonly text: string }>
        readonly source: Record<string, unknown>
      }>
      readonly system?: string
      readonly maxTokens?: number
      readonly temperature?: number
      readonly stop?: readonly string[]
      readonly signal?: AbortSignal
    }): AsyncIterable<{ readonly type: string; readonly text?: string }>
  }>
}

/** Structural event sink for the fiber-bound session/disposed listener. */
interface EventSink {
  on(name: string, listener: (payload: unknown) => void): unknown
}

/** Structural view of the disposed-session payload of `session/disposed`. */
export interface DisposedSessionLike {
  readonly id: string
  readonly header?: { readonly cwd?: string }
  readonly events?: readonly SessionEventLike[]
}

const PROPOSAL_SYSTEM = [
  'You distill finished-agent-session transcripts into compact, durable memory facts.',
  'Output ONLY a JSON array of strings, each an information-dense fact worth remembering across sessions',
  '(user preferences, conventions, decisions, environment facts, proven fixes).',
  'Exclude chitchat, transient progress, and anything already obvious. Never invent.',
  'Every fact must be verbatim-supported by the transcript. Reply with the JSON array and nothing else.',
].join(' ')

const candidatesSchema = z.array(z.string().min(1))

function parseCandidates(raw: string): string[] {
  const block = raw.match(/\[[\s\S]*\]/)?.[0]
  if (block === undefined) return []
  try {
    const parsed: unknown = JSON.parse(block)
    const result = candidatesSchema.safeParse(parsed)
    return result.success ? result.data : []
  } catch {
    return []
  }
}

async function distill(
  llm: LlmRuntimeLike,
  service: MemoryService,
  transcript: string,
  signal: AbortSignal,
): Promise<string[]> {
  const { proposalProvider, proposalModel, proposalMaxFacts } = service.config
  const maxTokens = Math.min(1024, 128 * proposalMaxFacts)
  const prepared = await llm.prepareCall({ provider: proposalProvider, model: proposalModel, maxTokens, temperature: 0.2 }, signal)
  let text = ''
  for await (const chunk of prepared.stream({
    // Spread the MATERIALIZED config: the runtime enforces exact equality
    // with it (callConfigEquals) and throws INVALID_PREPARED_CALL otherwise
    // — omitting the adapter-materialized reasoningEffort makes every call
    // fail in production while mocks that skip the check stay green.
    ...prepared.config,
    system: PROPOSAL_SYSTEM,
    messages: [{
      id: 'proposal-transcript',
      role: 'user',
      content: [{ type: 'text', text: transcript }],
      source: { kind: 'user' },
    }],
    signal,
  })) {
    if (chunk.type === 'text-delta' && chunk.text !== undefined) text += chunk.text
  }
  return parseCandidates(text)
}

/**
 * One distillation run for a disposed session; never throws — a failed
 * proposal must not disturb session shutdown.
 */
async function runProposal(ctx: Context, service: MemoryService, session: DisposedSessionLike): Promise<void> {
  const cwd = session.header?.cwd
  if (cwd === undefined || cwd.length === 0) return
  const llm = ctx.get('llm') as LlmRuntimeLike | undefined
  if (llm === undefined) return
  const events = session.events ?? []
  let transcript = ''
  for (const event of events) {
    const piece = eventText(event)
    if (piece.length > 0) transcript += piece + '\n'
  }
  if (transcript.trim().length === 0) return
  const tail = [...transcript].slice(-PROPOSAL_TRANSCRIPT_MAX_CHARS).join('')
  const signal = AbortSignal.timeout(90_000)
  let candidates: string[]
  try {
    candidates = await distill(llm, service, tail, signal)
  } catch {
    return
  }
  if (candidates.length === 0) return
  const domain = await service.getDomain().catch(() => undefined)
  if (domain === undefined) return
  const now = Date.now()
  const maxChars = service.config.maxFactChars
  for (const raw of candidates.slice(0, service.config.proposalMaxFacts)) {
    const text = maskSecrets([...raw.trim()].slice(0, maxChars).join(''))
    if (text.length === 0) continue
    await domain.addProposal({
      id: randomUUID(),
      workspacePath: cwd,
      text,
      sessionId: session.id,
      createdAt: now,
      state: 'pending',
    })
  }
}

/**
 * Register the session-end proposal hook; returns undefined when disabled.
 * The `session/disposed` listener is fiber-bound (Cordis unbinds it on
 * dispose), and the async body is fire-and-forget with errors contained.
 */
export function registerSessionEndProposal(ctx: Context, service: MemoryService): (() => void) | undefined {
  if (!service.config.proposeOnSessionEnd) return undefined
  const events = ctx as unknown as EventSink
  events.on('session/disposed', (payload: unknown) => {
    void runProposal(ctx, service, payload as DisposedSessionLike).catch(() => {})
  })
  return () => {
    // Nothing extra: the event binding lives on the plugin fiber.
  }
}
