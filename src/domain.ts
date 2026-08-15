// Memory domain over the host storage-domain facility.
//
// Verified contracts (deepseek-harness 0.1.0-rc.5, commit 47f9438):
//
//   ctx.storageDomain — DomainFacility service (web profile mounts
//     @deepseek-ai/dsh-storage-domain with backend: json, root
//     ~/.dsh/storages). Packages: packages/storage/storage-domain.
//
//   open(spec: DomainSpec): Promise<Domain>
//     DomainSpec: { name, version, global?, tables: Record<string, DomainTableSpec> }
//     DomainTableSpec: { valueSchema: ZodType<V>, __key?: K }
//     Helpers: defineDomain(spec), domainTable(schema)
//
//   Domain tables (KvTable<K, V>): get / put / delete / entries / keys / size
//     — reads are synchronous from authoritative in-memory state; writes
//     await backend durability FIRST, then mutate memory, then emit
//     domain/changed (so a rejected write never lingers in memory).
//
// The JSON backend persists one unit file per domain:
//   ~/.dsh/storages/<domain-name>.json   (same directory that already holds
//   workspace.json and session_projcache.json).
//
// The plugin does NOT import @deepseek-ai/dsh-storage-domain at runtime: the
// spec below is a plain object satisfying the facility's structural contract,
// and defineMemoryDomain reimplements the shipped defineDomain validation
// (name/version/null-global) so misconfiguration still fails loud at module
// load. The storage-domain tests run against the real published facility to
// prove the duck-typing.

import { z } from 'zod'

import type { ConfigType } from './config.ts'
import { MemoryError } from './errors.ts'

// ---------------------------------------------------------------------------
// Record schemas (zod v4, matching DSH's own storage-domain dependency).
// Validation at the durable boundary is the facility's job; these schemas are
// handed over as the domain's record contract.

export const FactSchema = z.object({
  /** Stable id; the table key. Use crypto.randomUUID(). */
  id: z.string().min(1),
  /** Workspace path this fact is scoped to (session cwd, resolved at write). */
  workspacePath: z.string().min(1),
  /** What the fact records. */
  kind: z.enum(['preference', 'fact', 'convention', 'decision']),
  /** Compact, information-dense text. */
  text: z.string().min(1),
  /** Free-form routing tags; recall matches text first, tags second. */
  tags: z.array(z.string()).default([]),
  /** Provenance: the session that wrote the fact and the log seq it observed. */
  sessionId: z.string().min(1),
  seq: z.number().int().nonnegative(),
  /** Epoch millis. */
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  /**
   * Recall-ordering metadata (added v0.3.0, optional for backward
   * compatibility with rows written before it): how often memory_recall has
   * returned this fact, and when last. Bumped by the tool layer after a
   * recall — content fields stay untouched, so no approval is involved.
   */
  accessCount: z.number().int().nonnegative().optional(),
  lastAccessedAt: z.number().int().nonnegative().optional(),
  /** Soft-delete: `forget` sets state to archived; recall ignores it. */
  state: z.enum(['active', 'archived']).default('active'),
})

export type Fact = z.infer<typeof FactSchema>

export const ProfileSchema = z.object({
  workspacePath: z.string().min(1),
  /** Few, dense entries — the always-injected budget (config caps them). */
  entries: z.array(z.string()).default([]),
  updatedAt: z.number().int().nonnegative(),
})

export type Profile = z.infer<typeof ProfileSchema>

/**
 * One LLM-distilled memory proposal from a finished session (v0.3.0,
 * opt-in). Pending proposals are shown in the next sessions' prompt; they
 * become facts only through memory_remember, whose approval gate does the
 * human check. Consumed on exact normalized-text match after a successful
 * remember; expired by TTL.
 */
export const ProposalSchema = z.object({
  /** Stable id; the table key. */
  id: z.string().min(1),
  /** Workspace the proposal targets (the disposed session's cwd). */
  workspacePath: z.string().min(1),
  /** Proposed fact text (secrets already masked by the distiller). */
  text: z.string().min(1),
  /** Provenance: the session the proposal was distilled from. */
  sessionId: z.string().min(1),
  /** Epoch millis. */
  createdAt: z.number().int().nonnegative(),
  state: z.enum(['pending', 'consumed', 'expired']).default('pending'),
})

export type Proposal = z.infer<typeof ProposalSchema>

/**
 * One compaction drift alarm (v0.3.0): anchors the summary dropped from the
 * shadowed turns. Rendered in the next sessions' prompt as DATA to verify;
 * expires by TTL. Not memory content — read-only surface, no approval.
 */
export const AlarmSchema = z.object({
  /** Stable id; the table key. */
  id: z.string().min(1),
  /** Workspace the alarm belongs to (the compacted session's cwd). */
  workspacePath: z.string().min(1),
  /** The session whose compaction dropped the anchors. */
  sessionId: z.string().min(1),
  /** Literal anchors that vanished from the summary (≤5, longest first). */
  vanishedAnchors: z.array(z.string()).max(5),
  /** The shadowed seq range, when the summary event carried it. */
  shadowedRange: z.object({
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
  }).optional(),
  /** Epoch millis. */
  createdAt: z.number().int().nonnegative(),
  state: z.enum(['active', 'expired']).default('active'),
})

export type Alarm = z.infer<typeof AlarmSchema>

// ---------------------------------------------------------------------------
// Domain spec (structural, self-contained).

/** Domain name doubles as the JSON unit name; must match UNIT_NAME_RE. */
export const MEMORY_DOMAIN = 'dsh_memory'
export const MEMORY_DOMAIN_VERSION = 1

/** The harness's UNIT_NAME_RE (packages/storage/storage/src/backend.ts). */
const UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/

/** Structural view of DomainTableSpec — a zod schema per table. */
export interface DomainTableSpec {
  readonly valueSchema: z.ZodType
}

/** Structural view of DomainGlobalSpec — schema plus the never-written initial. */
export interface DomainGlobalSpec {
  readonly schema: z.ZodType
  readonly initial: unknown
}

/** Structural view of DomainSpec; satisfies the real facility's parameter. */
export interface MemoryDomainSpec {
  readonly name: string
  readonly version: number
  readonly global?: DomainGlobalSpec
  readonly tables: Record<string, DomainTableSpec>
}

/** Structural view of a facility: open() is all this plugin needs. */
export interface StorageDomainFacility {
  open(spec: MemoryDomainSpec): Promise<OpenedDomain>
}

/** Structural view of one open domain: name, table resolution, close. */
export interface OpenedDomain {
  readonly name: string
  table(name: string): KvTable<unknown>
  close(): Promise<void>
}

/** Structural view of a KvTable handle. */
export interface KvTable<V> {
  get(key: string): V | undefined
  entries(): IterableIterator<[string, V]>
  keys(): IterableIterator<string>
  readonly size: number
  put(key: string, value: V): Promise<void>
  delete(key: string): Promise<boolean>
  update(key: string, fn: (current: V) => V): Promise<V>
}

/**
 * Declare one table. Mirrors the shipped `domainTable(schema)` helper, which
 * is exactly `{ valueSchema: schema }`.
 */
export function domainTable<V>(schema: z.ZodType<V>): DomainTableSpec {
  return { valueSchema: schema }
}

/**
 * Identity validation mirroring the shipped `defineDomain` (spec.ts of
 * dsh-storage-domain): a domain/table name outside UNIT_NAME_RE, a version
 * that is not a non-negative integer, or a global schema that accepts `null`
 * (the medium's "never written" sentinel) all throw at module load.
 */
export function defineMemoryDomain(spec: MemoryDomainSpec): MemoryDomainSpec {
  if (!UNIT_NAME_RE.test(spec.name)) {
    throw new Error(`memory domain name '${spec.name}' must match ${UNIT_NAME_RE}`)
  }
  if (!Number.isInteger(spec.version) || spec.version < 0) {
    throw new Error(`memory domain '${spec.name}' version must be a non-negative integer, got ${spec.version}`)
  }
  for (const table of Object.keys(spec.tables)) {
    if (!UNIT_NAME_RE.test(table)) {
      throw new Error(`memory domain '${spec.name}' table name '${table}' must match ${UNIT_NAME_RE}`)
    }
  }
  if (spec.global !== undefined && spec.global.schema.safeParse(null).success) {
    throw new Error(
      `memory domain '${spec.name}' global schema must not accept null: `
      + 'null is the medium\'s "never written" sentinel, so a stored null could not round-trip',
    )
  }
  return spec
}

/** The one memory domain spec, validated at module load. */
export const memoryDomainSpec = defineMemoryDomain({
  name: MEMORY_DOMAIN,
  version: MEMORY_DOMAIN_VERSION,
  global: {
    schema: z.object({ initialized: z.boolean() }),
    initial: { initialized: true },
  },
  tables: {
    facts: domainTable(FactSchema),
    profiles: domainTable(ProfileSchema),
    proposals: domainTable(ProposalSchema),
    alarms: domainTable(AlarmSchema),
  },
})

// ---------------------------------------------------------------------------
// Typed handle over one opened domain.

/** Default ceiling on recall results (deterministic top-N after ranking). */
export const RECALL_MAX_HITS = 20

export interface MemoryDomain {
  /** Insert or overwrite one fact; enforces caps at the durable boundary. */
  remember(fact: Fact): Promise<Fact>
  /** One workspace-scoped fact by id, active or archived; undefined when absent or foreign. */
  getFact(workspacePath: string, id: string): Fact | undefined
  /** Active facts of one workspace, newest-first (recall tiebreak order). */
  listActive(workspacePath: string): Fact[]
  /** Every active fact across all workspaces, newest-first (browser page). */
  listAllActive(): Fact[]
  /**
   * Deterministic bounded scan: text matches first, tags second, recency
   * tiebreak. An empty query lists the newest active facts.
   */
  recall(workspacePath: string, query?: string, limit?: number): Fact[]
  /**
   * Bump the recall-access counters of the given active facts (metadata-only
   * write, no approval, no cap movement).
   */
  touchFacts(workspacePath: string, ids: readonly string[]): Promise<void>
  /** Soft-delete one workspace-scoped fact. Returns false when absent/foreign/archived. */
  archive(workspacePath: string, id: string): Promise<boolean>
  /** Active facts in one workspace (cap accounting). */
  activeCount(workspacePath: string): number
  /** The workspace profile; an empty default when never written. */
  getProfile(workspacePath: string): Profile
  /** Persist one workspace profile; enforces entry caps. */
  putProfile(profile: Profile): Promise<Profile>
  /** Add one distilled proposal; expires stale pendings and enforces the pending cap. */
  addProposal(proposal: Proposal): Promise<void>
  /** Pending (unexpired) proposals of one workspace, oldest first. */
  pendingProposals(workspacePath: string): Proposal[]
  /** Mark pending proposals with equal normalized text as consumed. */
  consumeProposal(workspacePath: string, text: string): Promise<void>
  /** Add one drift alarm; expires stale alarms and enforces the active cap. */
  addAlarm(alarm: Alarm): Promise<void>
  /** Active (unexpired) alarms of one workspace, newest first. */
  activeAlarms(workspacePath: string): Alarm[]
  close(): Promise<void>
}

// ---------------------------------------------------------------------------
// Consolidation suggestions (deterministic, zero-dependency near-duplicate
// detection for the memory_consolidate tool).

/** Jaccard similarity at or above this marks two facts merge candidates. */
export const CONSOLIDATION_SIMILARITY = 0.55
/** Hard bound on the number of suggested pairs per call. */
export const CONSOLIDATION_MAX_PAIRS = 5

export interface ConsolidationCandidate {
  readonly a: Fact
  readonly b: Fact
  /** Jaccard similarity of the two facts' token sets, 0..1. */
  readonly similarity: number
  /** A proposed combined text (bounded) the model can refine via memory_edit. */
  readonly suggestedText: string
}

/**
 * Case-fold one fact's text into a token set: ASCII words plus CJK runs and
 * their overlapping bigrams (the same vocabulary the recall tokenizer uses).
 */
export function factTokens(text: string): Set<string> {
  const tokens = new Set<string>()
  const runs = text.toLowerCase().match(/[\u3400-\u9fff]+|[^\u3400-\u9fff]+/g) ?? []
  for (const run of runs) {
    if (/^[\u3400-\u9fff]+$/.test(run)) {
      tokens.add(run)
      for (let i = 0; i < run.length - 1; i += 1) tokens.add(run.slice(i, i + 2))
    } else {
      for (const word of run.split(/[^a-z0-9]+/)) {
        if (word.length > 0) tokens.add(word)
      }
    }
  }
  return tokens
}

/**
 * Deterministic near-duplicate scan over active facts: all pairs whose token
 * sets overlap by at least {@link CONSOLIDATION_SIMILARITY} (Jaccard), most
 * similar first, capped at {@link CONSOLIDATION_MAX_PAIRS}. Pure function —
 * reads only; the actual merge lands through the gated edit/forget tools.
 */
export function suggestConsolidations(facts: readonly Fact[]): ConsolidationCandidate[] {
  const tokenSets = facts.map(fact => ({ fact, tokens: factTokens(fact.text) }))
  const candidates: ConsolidationCandidate[] = []
  for (let i = 0; i < tokenSets.length; i += 1) {
    for (let j = i + 1; j < tokenSets.length; j += 1) {
      const left = tokenSets[i]!
      const right = tokenSets[j]!
      const intersection = [...left.tokens].filter(token => right.tokens.has(token)).length
      const union = new Set([...left.tokens, ...right.tokens]).size
      if (union === 0) continue
      const similarity = intersection / union
      if (similarity < CONSOLIDATION_SIMILARITY) continue
      candidates.push({
        a: left.fact,
        b: right.fact,
        similarity,
        suggestedText: `${left.fact.text} ${right.fact.text}`.slice(0, 600),
      })
    }
  }
  return candidates
    .sort((x, y) => y.similarity - x.similarity
      || x.a.id.localeCompare(y.a.id)
      || x.b.id.localeCompare(y.b.id))
    .slice(0, CONSOLIDATION_MAX_PAIRS)
}

/**
 * Case-fold and split a recall query into unique tokens. Whitespace-separated
 * words are further split between CJK and non-CJK runs (so mixed queries like
 * "ci交互" yield the ASCII token "ci"), and every CJK run also contributes
 * its overlapping bigrams — deterministic CJK n-gram recall without any
 * semantic dependency.
 */
function tokenize(query: string): string[] {
  const tokens = new Set<string>()
  for (const word of query.toLowerCase().split(/\s+/)) {
    const runs = word.match(/[\u3400-\u9fff]+|[^\u3400-\u9fff]+/g) ?? []
    for (const run of runs) {
      tokens.add(run)
      if (/^[\u3400-\u9fff]+$/.test(run) && run.length >= 2) {
        for (let i = 0; i < run.length - 1; i += 1) tokens.add(run.slice(i, i + 2))
      }
    }
  }
  return [...tokens].filter(token => token.length > 0)
}

/**
 * Three-tier deterministic scoring: exact tag match (curated routing) is the
 * strongest signal, case-insensitive text substring next, fuzzy tag overlap
 * last. The whole folded query as one substring gets an extra boost for
 * MULTI-WORD phrases only, so a single-token query cannot ride its own
 * substring twice.
 */
function scoreFact(fact: Fact, tokens: readonly string[], fullQuery: string, phraseBoost: boolean): number {
  const text = fact.text.toLowerCase()
  const tags = fact.tags.map(tag => tag.toLowerCase())
  let score = 0
  for (const token of tokens) {
    if (tags.includes(token)) score += 3
    else if (tags.some(tag => tag.includes(token) || token.includes(tag))) score += 1
    if (text.includes(token)) score += 2
  }
  if (phraseBoost && fullQuery.length > 1 && text.includes(fullQuery)) score += 4
  return score
}

/** Deterministic recency ordering: newest updatedAt, then id ascending. */
function compareRecency(left: Fact, right: Fact): number {
  return right.updatedAt - left.updatedAt || left.id.localeCompare(right.id)
}

/**
 * Freshness of one fact by its updatedAt age, in three states (forge-style):
 * fresh ≤ recallFreshWindowDays, current ≤ recallStaleWindowDays, stale beyond.
 */
function freshnessWeight(fact: Fact, now: number, config: ConfigType): number {
  const ageDays = (now - fact.updatedAt) / 86_400_000
  if (ageDays <= config.recallFreshWindowDays) return 1
  if (ageDays <= config.recallStaleWindowDays) return 0.8
  return 0.5
}

/**
 * Within-tier recall signals: freshness (0.5–1.0) and access frequency
 * (0–10 counts, normalized). Each signal contributes at most 0.4 to the total,
 * so the sum is always < 1 — a lower text tier can never outrank a higher one
 * (tag-exact stays above substring stays above fuzzy, per the acceptance).
 */
function recallSignals(fact: Fact, now: number, config: ConfigType): number {
  const access = Math.min(1, (fact.accessCount ?? 0) / 10)
  return 0.4 * freshnessWeight(fact, now, config) + 0.4 * access
}

/** Open the memory domain over a facility and return the typed handle. */
export async function openMemoryDomain(
  facility: StorageDomainFacility,
  config: ConfigType,
): Promise<MemoryDomain> {
  const opened = await facility.open(memoryDomainSpec)
  const facts = opened.table('facts') as unknown as KvTable<Fact>
  const profiles = opened.table('profiles') as unknown as KvTable<Profile>
  const proposals = opened.table('proposals') as unknown as KvTable<Proposal>
  const alarms = opened.table('alarms') as unknown as KvTable<Alarm>

  const scopedFact = (workspacePath: string, fact: Fact): Fact | undefined =>
    fact.workspacePath === workspacePath ? fact : undefined

  const activeIn = (workspacePath: string): Fact[] =>
    [...facts.entries()]
      .map(([, fact]) => fact)
      .filter(fact => fact.workspacePath === workspacePath && fact.state === 'active')

  return {
    async remember(fact: Fact): Promise<Fact> {
      if (fact.state !== 'active') {
        throw new MemoryError('MEMORY_INVALID_ARGS', 'memory fact must be active when stored')
      }
      if ([...fact.text].length > config.maxFactChars) {
        throw new MemoryError(
          'MEMORY_CAP_EXCEEDED',
          `fact text is ${[...fact.text].length} characters, over the cap of ${config.maxFactChars}; `
          + 'split the fact or consolidate with memory_edit',
        )
      }
      const existing = facts.get(fact.id)
      const count = activeIn(fact.workspacePath).length - (existing !== undefined && existing.state === 'active' ? 1 : 0)
      if (count >= config.maxFactsPerWorkspace) {
        throw new MemoryError(
          'MEMORY_CAP_EXCEEDED',
          `workspace already holds ${config.maxFactsPerWorkspace} active facts (the cap); `
          + 'consolidate related facts with memory_edit or forget stale ones with memory_forget first',
        )
      }
      await facts.put(fact.id, fact)
      return fact
    },

    getFact(workspacePath: string, id: string): Fact | undefined {
      const fact = facts.get(id)
      return fact === undefined ? undefined : scopedFact(workspacePath, fact)
    },

    listActive(workspacePath: string): Fact[] {
      return activeIn(workspacePath).sort(compareRecency)
    },

    listAllActive(): Fact[] {
      return [...facts.entries()]
        .map(([, fact]) => fact)
        .filter(fact => fact.state === 'active')
        .sort(compareRecency)
    },

    recall(workspacePath: string, query?: string, limit: number = RECALL_MAX_HITS): Fact[] {
      const bounded = Math.max(1, Math.min(50, Math.trunc(limit) || RECALL_MAX_HITS))
      const active = activeIn(workspacePath)
      if (query === undefined) return active.sort(compareRecency).slice(0, bounded)
      const tokens = tokenize(query)
      if (tokens.length === 0) return active.sort(compareRecency).slice(0, bounded)
      const folded = query.trim().toLowerCase()
      const phraseBoost = /\s/.test(query.trim())
      const now = Date.now()
      return active
        .map(fact => ({ fact, tier: scoreFact(fact, tokens, folded, phraseBoost) }))
        .filter(entry => entry.tier > 0)
        .map(entry => ({ fact: entry.fact, score: entry.tier + recallSignals(entry.fact, now, config) }))
        .sort((left, right) => right.score - left.score || compareRecency(left.fact, right.fact))
        .slice(0, bounded)
        .map(entry => entry.fact)
    },

    /**
     * Bump the recall-access counters of the given active facts (metadata-only
     * write: text/kind/tags/state/provenance stay untouched, so it needs no
     * approval and does not move cap accounting). Missing, foreign, or
     * archived ids are skipped.
     */
    async touchFacts(workspacePath: string, ids: readonly string[]): Promise<void> {
      const now = Date.now()
      await Promise.all(ids.map(async (id) => {
        const stored = facts.get(id)
        const fact = stored === undefined ? undefined : scopedFact(workspacePath, stored)
        if (fact === undefined || fact.state !== 'active') return
        await facts.put(fact.id, {
          ...fact,
          accessCount: (fact.accessCount ?? 0) + 1,
          lastAccessedAt: now,
        })
      }))
    },

    async archive(workspacePath: string, id: string): Promise<boolean> {
      const stored = facts.get(id)
      const fact = stored === undefined ? undefined : scopedFact(workspacePath, stored)
      if (fact === undefined || fact.state === 'archived') return false
      await facts.put(fact.id, { ...fact, state: 'archived', updatedAt: Date.now() })
      return true
    },

    activeCount(workspacePath: string): number {
      return activeIn(workspacePath).length
    },

    getProfile(workspacePath: string): Profile {
      return profiles.get(workspacePath) ?? { workspacePath, entries: [], updatedAt: 0 }
    },

    async putProfile(profile: Profile): Promise<Profile> {
      const entries = profile.entries.filter(entry => entry.trim().length > 0)
      if (entries.length > config.maxProfileEntries) {
        throw new MemoryError(
          'MEMORY_CAP_EXCEEDED',
          `workspace profile would hold ${entries.length} entries, over the cap of ${config.maxProfileEntries}; `
          + 'consolidate entries (replace with memory_remember target:"profile", or drop with empty text)',
        )
      }
      for (const entry of entries) {
        if ([...entry].length > config.maxProfileEntryChars) {
          throw new MemoryError(
            'MEMORY_CAP_EXCEEDED',
            `a profile entry is ${[...entry].length} characters, over the cap of ${config.maxProfileEntryChars}; shorten it`,
          )
        }
      }
      const next: Profile = { workspacePath: profile.workspacePath, entries, updatedAt: Date.now() }
      await profiles.put(profile.workspacePath, next)
      return next
    },

    async addProposal(proposal: Proposal): Promise<void> {
      const now = Date.now()
      const ttl = config.proposalTtlDays * 86_400_000
      // The cap is PER WORKSPACE (review residual #35): other workspaces'
      // pendings must neither expire here nor count against this cap.
      const pending = [...proposals.entries()]
        .map(([, item]) => item)
        .filter(item => item.workspacePath === proposal.workspacePath && item.state === 'pending')
        .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
      for (const stale of pending.filter(item => now - item.createdAt > ttl)) {
        await proposals.put(stale.id, { ...stale, state: 'expired' })
      }
      const live = pending.filter(item => now - item.createdAt <= ttl)
      // The cap applies AFTER the new proposal lands: keep maxPending - 1
      // of the existing pendings (oldest expire first).
      const overflow = live.length + 1 - config.proposalMaxPending
      for (const oldest of live.slice(0, Math.max(0, overflow))) {
        await proposals.put(oldest.id, { ...oldest, state: 'expired' })
      }
      await proposals.put(proposal.id, proposal)
    },

    pendingProposals(workspacePath: string): Proposal[] {
      const now = Date.now()
      const ttl = config.proposalTtlDays * 86_400_000
      return [...proposals.entries()]
        .map(([, proposal]) => proposal)
        .filter(proposal =>
          proposal.workspacePath === workspacePath
          && proposal.state === 'pending'
          && now - proposal.createdAt <= ttl)
        .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
    },

    async consumeProposal(workspacePath: string, text: string): Promise<void> {
      const normalized = text.trim().replace(/\s+/g, ' ')
      for (const [, proposal] of proposals.entries()) {
        if (proposal.workspacePath !== workspacePath || proposal.state !== 'pending') continue
        if (proposal.text.trim().replace(/\s+/g, ' ') === normalized) {
          await proposals.put(proposal.id, { ...proposal, state: 'consumed' })
        }
      }
    },

    async addAlarm(alarm: Alarm): Promise<void> {
      const now = Date.now()
      const ttl = config.guardAlarmTtlHours * 3_600_000
      // The cap is PER WORKSPACE (review residual #35): other workspaces'
      // alarms must neither expire here nor count against this cap.
      const active = [...alarms.entries()]
        .map(([, item]) => item)
        .filter(item => item.workspacePath === alarm.workspacePath && item.state === 'active')
        .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
      for (const stale of active.filter(item => now - item.createdAt > ttl)) {
        await alarms.put(stale.id, { ...stale, state: 'expired' })
      }
      const live = active.filter(item => now - item.createdAt <= ttl)
      const overflow = live.length + 1 - config.guardAlarmMax
      for (const oldest of live.slice(0, Math.max(0, overflow))) {
        await alarms.put(oldest.id, { ...oldest, state: 'expired' })
      }
      await alarms.put(alarm.id, alarm)
    },

    activeAlarms(workspacePath: string): Alarm[] {
      const now = Date.now()
      const ttl = config.guardAlarmTtlHours * 3_600_000
      return [...alarms.entries()]
        .map(([, alarm]) => alarm)
        .filter(alarm =>
          alarm.workspacePath === workspacePath
          && alarm.state === 'active'
          && now - alarm.createdAt <= ttl)
        .sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id))
    },

    close(): Promise<void> {
      return opened.close()
    },
  }
}
