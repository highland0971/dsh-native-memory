// Shared test harness: a Cordis context with the storage hub, one in-memory
// backend, and the real DomainFacility (the harness's own pattern — see
// packages/storage/storage-domain/tests/domain.spec.ts in the checkout).
//
// Importing the published @deepseek-ai/dsh-storage-domain here is what proves
// the plugin's structural duck-typing: src/domain.ts builds its spec as a
// plain object and the REAL facility must accept it.

import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'

import { Config } from '../../src/config.ts'
import type { ConfigType } from '../../src/config.ts'
import { openMemoryDomain } from '../../src/domain.ts'
import type { MemoryDomain, StorageDomainFacility } from '../../src/domain.ts'
import { MemoryMediaPool, MemoryStorageBackend } from './memory-backend.ts'

export interface MemoryHarness {
  readonly ctx: Context
  readonly facility: DomainFacility
  readonly backend: MemoryStorageBackend
  readonly pool: MemoryMediaPool
  readonly domain: MemoryDomain
  readonly config: ConfigType
}

/** Resolve plugin config with defaults over a small override. */
export function resolveConfig(overrides: Record<string, unknown> = {}): ConfigType {
  return Config.parse(overrides)
}

/**
 * Boot the storage hub + memory backend + real domain facility and open OUR
 * memory domain over it. `pool` and `backend` stay exposed so tests can
 * inject version stamps and write failures or reopen after a "restart".
 */
export async function bootMemory(
  overrides: Record<string, unknown> = {},
  pool: MemoryMediaPool = new MemoryMediaPool(),
): Promise<MemoryHarness> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend(pool)
  ctx.storage.backend.register('memory', backend)
  const facility = new DomainFacility(ctx, { backend: 'memory' })
  // Mounted on the hub (invariant cross-checks) AND provided as the
  // 'storageDomain' service, exactly like the plugin's own apply().
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  const config = resolveConfig(overrides)
  // The facility is the REAL rc.6 implementation; the cast crosses the
  // type-level generic boundary — runtime duck-typing is exactly what the
  // published plugin relies on in a real profile.
  const domain = await openMemoryDomain(facility as unknown as StorageDomainFacility, config)
  return { ctx, facility, backend, pool, domain, config }
}

/** Build one fact for tests; unspecified fields get stable defaults. */
export function makeFact(overrides: Partial<import('../../src/domain.ts').Fact> = {}) {
  const now = Date.now()
  return {
    id: crypto.randomUUID(),
    workspacePath: '/home/user/project',
    kind: 'fact' as const,
    text: 'the build is reproducible',
    tags: [] as string[],
    sessionId: 'sess-1',
    seq: 3,
    createdAt: now,
    updatedAt: now,
    state: 'active' as const,
    ...overrides,
  }
}
