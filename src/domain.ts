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
  /**
   * Deterministic bounded scan: text matches first, tags second, recency
   * tiebreak. An empty query lists the newest active facts.
   */
  recall(workspacePath: string, query?: string, limit?: number): Fact[]
  /** Soft-delete one workspace-scoped fact. Returns false when absent/foreign/archived. */
  archive(workspacePath: string, id: string): Promise<boolean>
  /** Active facts in one workspace (cap accounting). */
  activeCount(workspacePath: string): number
  /** The workspace profile; an empty default when never written. */
  getProfile(workspacePath: string): Profile
  /** Persist one workspace profile; enforces entry caps. */
  putProfile(profile: Profile): Promise<Profile>
  close(): Promise<void>
}

/** Case-fold and split a recall query into unique tokens. */
function tokenize(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/\s+/).filter(token => token.length > 0))]
}

/** Text matches count double, tag matches single; the union of distinct tokens. */
function scoreFact(fact: Fact, tokens: readonly string[]): number {
  const text = fact.text.toLowerCase()
  let score = 0
  for (const token of tokens) {
    if (text.includes(token)) score += 2
    if (fact.tags.some(tag => tag.toLowerCase() === token)) score += 1
  }
  return score
}

/** Deterministic recency ordering: newest updatedAt, then id ascending. */
function compareRecency(left: Fact, right: Fact): number {
  return right.updatedAt - left.updatedAt || left.id.localeCompare(right.id)
}

/** Open the memory domain over a facility and return the typed handle. */
export async function openMemoryDomain(
  facility: StorageDomainFacility,
  config: ConfigType,
): Promise<MemoryDomain> {
  const opened = await facility.open(memoryDomainSpec)
  const facts = opened.table('facts') as unknown as KvTable<Fact>
  const profiles = opened.table('profiles') as unknown as KvTable<Profile>

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

    recall(workspacePath: string, query?: string, limit: number = RECALL_MAX_HITS): Fact[] {
      const bounded = Math.max(1, Math.min(50, Math.trunc(limit) || RECALL_MAX_HITS))
      const active = activeIn(workspacePath)
      const tokens = query === undefined ? [] : tokenize(query)
      if (tokens.length === 0) return active.sort(compareRecency).slice(0, bounded)
      return active
        .map(fact => ({ fact, score: scoreFact(fact, tokens) }))
        .filter(entry => entry.score > 0)
        .sort((left, right) => right.score - left.score || compareRecency(left.fact, right.fact))
        .slice(0, bounded)
        .map(entry => entry.fact)
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

    close(): Promise<void> {
      return opened.close()
    },
  }
}
