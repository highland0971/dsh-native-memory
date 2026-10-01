// Compaction drift guard (v0.3.0, on by default): when a compaction summary
// drops key literal anchors that were present in the shadowed turns, record a
// bounded alarm and surface it in the next sessions' prompt as DATA to
// verify. Mirrors ICCuse/dsh-premise-guard and Yiipu/dsh-agentmemory's
// pre-compaction re-injection concern — but deterministic, zero-LLM,
// zero extra model call, and riding our verified systemPrompt channel
// instead of an agent/pre-step injection.
//
// Event contract (packages/compaction/compaction/src/types.ts:34-50, identical
// in 0.1.5-rc.2 and 0.2.0-rc.2): after a successful compaction the session
// appends 'compaction/summary' with data { summary: ContentBlock[],
// shadowedSeqs, shadowedRange: {start, end}, … }.
// 'session/event' (packages/core/session/src/index.ts:405) fires per appended
// event with (session, event).
//
// The shadowed text is re-derived from the durable log by seq — the session
// object itself carries NO event array in 0.2.0-rc.2 (issue #39), so it comes
// from ctx.sessionQuery.readSession, whose corpus is live-preferred
// (packages/session-query/session-query/src/corpus.ts:34-35) and therefore
// still sees a live session's log at compaction time.

import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'

import { maskSecrets } from './redaction.ts'
import type { MemoryService } from './tools.ts'
import type { SessionContentBlockLike, SessionEventLike } from './types.ts'

/** How many vanished anchors one alarm carries at most. */
export const ALARM_ANCHOR_MAX = 5

/** Structural view of the 'session/event' payload pair. */
export interface GuardSessionLike {
  readonly id: string
  readonly header?: { readonly cwd?: string }
}

/** Structural view of a 'compaction/summary' event's data. */
export interface CompactionSummaryLike {
  readonly type?: string
  readonly data?: {
    /** ContentBlock[] on the wire (compaction/src/types.ts:37), never a plain string. */
    readonly summary?: readonly SessionContentBlockLike[]
    readonly shadowedSeqs?: readonly unknown[]
    readonly shadowedRange?: { readonly start: number; readonly end: number }
  }
}

/** Structural event sink for the fiber-bound session/event listener. */
interface EventSink {
  on(name: string, listener: (session: unknown, event: unknown) => void): unknown
}

// ---------------------------------------------------------------------------
// Deterministic anchor extraction (pure; unit-tested).

const ANCHOR_PATTERNS: readonly RegExp[] = [
  /"([^"\n]{6,80})"/g,
  /'([^'\n]{6,80})'/g,
  /`([^`\n]{6,80})`/g,
  // Path-like runs: optional leading slash, then ≥2 segments.
  /(^|[\s(])(\/?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+)(?=$|[\s),.;:])/g,
  /\b([A-Za-z_][A-Za-z0-9_-]{2,}=[A-Za-z0-9_./:-]{2,})/g,
  /\b(ENOENT|EACCES|EPERM|ECONNREFUSED|ETIMEDOUT|ERR_[A-Z0-9_]{3,})\b/g,
]

const STOPWORDS = new Set([
  'the', 'this', 'that', 'these', 'those', 'with', 'from', 'have', 'will', 'would',
  'should', 'could', 'here', 'there', 'their', 'they', 'them', 'what', 'when',
  'where', 'which', 'your', 'into', 'about', 'because', 'really', 'please',
  'other', 'after', 'before', 'while', 'being', 'been', 'more', 'most', 'such',
])

/** A candidate must look technical: digits/symbols, a long run, a real phrase, or an all-caps token. */
function distinctive(anchor: string): boolean {
  if (/[0-9_=./:-]/.test(anchor)) return true
  if (/^[A-Z][A-Z0-9_]{3,}$/.test(anchor)) return true
  if ([...anchor].length >= 12) return true
  return anchor.split(/\s+/).filter(word => word.length > 0).length >= 3
}

/**
 * Extract stable literal anchors from the shadowed turns: quoted literals,
 * path-like runs, key=value pairs, error tokens. Longest first, deduped.
 */
export function extractAnchors(text: string): string[] {
  const anchors = new Set<string>()
  for (const pattern of ANCHOR_PATTERNS) {
    pattern.lastIndex = 0
    for (const match of text.matchAll(pattern)) {
      const raw = (match[2] ?? match[1] ?? match[0]).trim()
      // Strip punctuation the greedy value classes may have swallowed
      // (e.g. key=value runs absorb the sentence-ending period).
      const candidate = raw.replace(/^[.,;:!?\s]+|[.,;:!?\s]+$/g, '')
      if (candidate.length < 5 || candidate.length > 80) continue
      if (STOPWORDS.has(candidate.toLowerCase())) continue
      if (!distinctive(candidate)) continue
      anchors.add(candidate)
    }
  }
  return [...anchors].sort((left, right) => right.length - left.length)
}

/** Anchors whose case-folded text no longer appears in the summary. */
export function vanishedAnchors(anchors: readonly string[], summary: string): string[] {
  const folded = summary.toLowerCase()
  return anchors.filter(anchor => !folded.includes(anchor.toLowerCase()))
}

// ---------------------------------------------------------------------------

async function onSessionEvent(
  ctx: Context,
  service: MemoryService,
  session: GuardSessionLike,
  event: CompactionSummaryLike,
): Promise<void> {
  if (event?.type !== 'compaction/summary') return
  const summaryBlocks = event.data?.summary
  const shadowedSeqs = event.data?.shadowedSeqs
  if (summaryBlocks === undefined || shadowedSeqs === undefined) return
  const summary = blocksText(summaryBlocks)
  if (summary.length === 0) return
  const cwd = session.header?.cwd
  if (cwd === undefined || cwd.length === 0) return

  const seqSet = new Set(shadowedSeqs.filter((seq): seq is number => typeof seq === 'number'))
  if (seqSet.size === 0) return

  // The shadowed turns are re-read from the log: 0.2.0-rc.2's Session has no
  // event array (issue #39), and readSession's corpus is live-preferred, so a
  // compaction inside a live session still resolves its own events.
  const query = service.sessionQuery
  if (query === undefined) {
    ctx.logger('memory').warn(
      'compaction guard: sessionQuery is unavailable in this profile — drift check skipped',
    )
    return
  }
  const snapshot = await query.readSession(session.id).catch((error: unknown) => {
    ctx.logger('memory').warn(
      `compaction guard: cannot read session ${session.id} for the drift check: ${String(error)}`,
    )
    return undefined
  })
  if (snapshot === undefined) return

  // The guard derives the shadowed text itself instead of reusing eventText:
  // tool outputs live in nested tool-result blocks, and dropped literal
  // anchors (paths, error codes) appear there more often than anywhere else
  // (review residual #35).
  const shadowedText = snapshot.events
    .filter(event => event.seq !== undefined && seqSet.has(event.seq))
    .map(deepEventText)
    .join('\n')
  if (shadowedText.length === 0) return

  const vanished = vanishedAnchors(extractAnchors(shadowedText), summary).slice(0, ALARM_ANCHOR_MAX)
  if (vanished.length === 0) return

  const domain = await service.getDomain().catch(() => undefined)
  if (domain === undefined) return
  await domain.addAlarm({
    id: randomUUID(),
    workspacePath: cwd,
    sessionId: session.id,
    // Mask BEFORE storage, matching the proposal convention: the anchors
    // themselves are injected into later prompts, and the render-side mask
    // stays as defense in depth.
    vanishedAnchors: vanished.map(anchor => maskSecrets(anchor)),
    ...(event.data?.shadowedRange === undefined ? {} : { shadowedRange: event.data.shadowedRange }),
    createdAt: Date.now(),
    state: 'active',
  })
}

/**
 * Concatenated text of one event body. Tool results arrive as `tool`-role
 * messages whose content is already flat text blocks: session format v4
 * refuses the retired `tool-result` wrapper and 0.2.0-rc.2 dropped the block
 * type (retired-syntax.ts:6-9, llm/src/types.ts:137-145), so one level of
 * text extraction is the whole contract.
 */
function deepEventText(event: SessionEventLike): string {
  const blocks = event.data?.message?.content ?? event.data?.content ?? []
  return blocksText(blocks)
}

/**
 * Concatenated text of one content-block list. Used for both event bodies and
 * the compaction summary, whose payload is `ContentBlock[]`
 * (compaction/src/types.ts:37).
 */
function blocksText(blocks: readonly SessionContentBlockLike[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    if (block.type === 'text' && block.text !== undefined) parts.push(block.text)
  }
  return parts.join(' ')
}

/**
 * Register the compaction drift guard; returns undefined when disabled via
 * config. The 'session/event' listener is fiber-bound and the async body is
 * fire-and-forget with errors contained.
 */
export function registerCompactionGuard(ctx: Context, service: MemoryService): (() => void) | undefined {
  if (!service.config.compactionGuard) return undefined
  const events = ctx as unknown as EventSink
  events.on('session/event', (session: unknown, event: unknown) => {
    void onSessionEvent(ctx, service, session as GuardSessionLike, event as CompactionSummaryLike).catch(
      () => {},
    )
  })
  return () => {
    // Nothing extra: the event binding lives on the plugin fiber.
  }
}
