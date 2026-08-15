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

import { z } from 'zod'

// Zod is imported from THIS package's dependency (declared in package.json).
// DSH's storage-domain accepts any structurally-valid zod v4 schema — it
// stores the schema and validates at the durable boundary.

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

/** Domain name doubles as the JSON unit name; must match UNIT_NAME_RE. */
export const MEMORY_DOMAIN = 'dsh_memory'
export const MEMORY_DOMAIN_VERSION = 1

// TODO(implement): build the DomainSpec with defineDomain + domainTable and
// export an openMemoryDomain(ctx, config) that opens it once, lazily, and
// returns { facts, profiles } handles plus the workspace-authorization
// helper (a caller may only read/write facts whose workspacePath equals its
// own session cwd — the same exact-cwd rule dsh-tool-session-query applies).

export interface MemoryDomain {
  // TODO(implement): typed wrappers over the opened Domain:
  //   remember(fact: Fact): Promise<Fact>
  //   listActive(workspacePath: string): Fact[]
  //   recall(workspacePath: string, query: string): Fact[]   // deterministic bounded scan
  //   archive(workspacePath: string, id: string): Promise<void>
  //   getProfile(workspacePath: string): Profile
  //   putProfile(profile: Profile): Promise<void>
}
