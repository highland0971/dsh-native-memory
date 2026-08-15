// Compaction drift guard (v0.3.0, on by default): when a compaction summary
// drops key literal anchors that were present in the shadowed turns, record a
// bounded alarm and surface it in the next sessions' prompt as DATA to
// verify. Mirrors ICCuse/dsh-premise-guard and Yiipu/dsh-agentmemory's
// pre-compaction re-injection concern — but deterministic, zero-LLM,
// zero extra model call, and riding our verified systemPrompt channel
// instead of an agent/pre-step injection.
//
// Event contract (packages/compaction/compaction-basic/src/region.ts:442+):
// after a successful compaction the session appends 'compaction/summary'
// with data { summary, shadowedSeqs, shadowedRange: {start, end}, … }.
// 'session/event' (packages/core/session/src/index.ts:76) fires per appended
// event with (session, event); the append-only session log still holds the
// shadowed turns, so the pre-compaction text can be re-derived by seq.

import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'

import { eventText } from './tools.ts'
import type { MemoryService } from './tools.ts'
import type { SessionEventLike } from './types.ts'

/** How many vanished anchors one alarm carries at most. */
export const ALARM_ANCHOR_MAX = 5

/** Structural view of the 'session/event' payload pair. */
export interface GuardSessionLike {
  readonly id: string
  readonly header?: { readonly cwd?: string }
  readonly events?: readonly SessionEventLike[]
}

/** Structural view of a 'compaction/summary' event's data. */
export interface CompactionSummaryLike {
  readonly type?: string
  readonly data?: {
    readonly summary?: string
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
  service: MemoryService,
  session: GuardSessionLike,
  event: CompactionSummaryLike,
): Promise<void> {
  if (event?.type !== 'compaction/summary') return
  const summary = event.data?.summary
  const shadowedSeqs = event.data?.shadowedSeqs
  if (typeof summary !== 'string' || shadowedSeqs === undefined) return
  const cwd = session.header?.cwd
  if (cwd === undefined || cwd.length === 0) return

  const seqSet = new Set(shadowedSeqs.filter((seq): seq is number => typeof seq === 'number'))
  const shadowedText = (session.events ?? [])
    .filter(event => event.seq !== undefined && seqSet.has(event.seq))
    .map(eventText)
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
    vanishedAnchors: vanished,
    ...(event.data?.shadowedRange === undefined ? {} : { shadowedRange: event.data.shadowedRange }),
    createdAt: Date.now(),
    state: 'active',
  })
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
    void onSessionEvent(service, session as GuardSessionLike, event as CompactionSummaryLike).catch(() => {})
  })
  return () => {
    // Nothing extra: the event binding lives on the plugin fiber.
  }
}
