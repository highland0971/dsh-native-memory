// Domain unit tests: the memory domain opened over the REAL published
// DomainFacility with an in-memory backend (the harness's own pattern).
//
// Contract under test: remember/listActive/recall/archive/getProfile/
// putProfile, exact-cwd authorization, caps, provenance fields, durability
// failure negative path, version-mismatch loud failure.

import { describe, expect, it } from 'vitest'

import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'

import { MEMORY_DOMAIN_VERSION, defineMemoryDomain, factTokens, openMemoryDomain, suggestConsolidations } from '../src/domain.ts'
import type { StorageDomainFacility } from '../src/domain.ts'
import { bootMemory, makeFact, resolveConfig } from './helpers/harness.ts'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'

const WS = '/home/user/project'
const OTHER = '/home/user/other-project'

describe('defineMemoryDomain', () => {
  it('validates domain and table names like the shipped defineDomain', () => {
    expect(() => defineMemoryDomain({ name: 'Bad-Name', version: 1, tables: {} })).toThrow(/must match/)
    expect(() => defineMemoryDomain({ name: 'ok', version: 1.5, tables: {} })).toThrow(/non-negative integer/)
    expect(() => defineMemoryDomain({ name: 'ok', version: 1, tables: { 'Bad Table': { valueSchema: {} } } } as never))
      .toThrow(/table name/)
  })
})

describe('memory domain over the real facility', () => {
  it('opens and persists facts across a simulated restart (shared medium)', async () => {
    const pool = new MemoryMediaPool()
    const first = await bootMemory({}, pool)
    await first.domain.remember(makeFact({ workspacePath: WS, text: 'prefers tabs' }))
    await first.domain.close()

    const second = await bootMemory({}, pool)
    expect(second.domain.listActive(WS).map(fact => fact.text)).toEqual(['prefers tabs'])
  })

  it('remember stores full provenance and survives a durability failure untouched', async () => {
    const { domain, pool } = await bootMemory()
    const fact = makeFact({ workspacePath: WS, sessionId: 'sess-7', seq: 42 })
    const stored = await domain.remember(fact)
    expect(stored).toEqual(fact)

    pool.failNextWrites = 1
    await expect(domain.remember(makeFact({ workspacePath: WS, text: 'never lands' })))
      .rejects.toThrow('injected write failure')
    expect(domain.activeCount(WS)).toBe(1)
    expect(domain.getFact(WS, 'absent-id')).toBeUndefined()
  })

  it('enforces the fact text cap with consolidation guidance', async () => {
    const { domain, config } = await bootMemory({ maxFactChars: 10 })
    await expect(domain.remember(makeFact({ workspacePath: WS, text: '12345678901' })))
      .rejects.toMatchObject({ name: 'MemoryError', code: 'MEMORY_CAP_EXCEEDED' })
    expect(config.maxFactChars).toBe(10)
    await expect(domain.remember(makeFact({ workspacePath: WS, text: 'short' }))).resolves.toBeDefined()
  })

  it('enforces the per-workspace facts cap, but updates of existing ids bypass it', async () => {
    const { domain } = await bootMemory({ maxFactsPerWorkspace: 2 })
    const first = await domain.remember(makeFact({ workspacePath: WS, text: 'one' }))
    await domain.remember(makeFact({ workspacePath: WS, text: 'two' }))
    await expect(domain.remember(makeFact({ workspacePath: WS, text: 'three' })))
      .rejects.toMatchObject({ code: 'MEMORY_CAP_EXCEEDED' })

    // An update of an existing id is not a new fact.
    await domain.remember({ ...first, text: 'one, revised', updatedAt: Date.now() })
    expect(domain.activeCount(WS)).toBe(2)

    // The cap is per workspace — another workspace is unaffected.
    await expect(domain.remember(makeFact({ workspacePath: OTHER, text: 'other' }))).resolves.toBeDefined()
  })

  it('listActive is exact-cwd: foreign workspaces and archived facts are invisible', async () => {
    const { domain } = await bootMemory()
    const kept = await domain.remember(makeFact({ workspacePath: WS, text: 'kept' }))
    await domain.remember(makeFact({ workspacePath: OTHER, text: 'foreign' }))
    const archived = await domain.remember(makeFact({ workspacePath: WS, text: 'gone' }))
    await domain.archive(WS, archived.id)

    expect(domain.listActive(WS).map(fact => fact.id)).toEqual([kept.id])
    expect(domain.activeCount(WS)).toBe(1)
    expect(domain.activeCount(OTHER)).toBe(1)
  })

  it('recall ranks exact tags first, text substrings next, recency tiebreak; empty query lists newest', async () => {
    const { domain } = await bootMemory()
    const now = Date.now()
    await domain.remember(makeFact({ workspacePath: WS, text: 'the ci pipeline is slow', updatedAt: now - 3000 }))
    await domain.remember(makeFact({ workspacePath: WS, text: 'unrelated note', tags: ['ci'], updatedAt: now - 2000 }))
    await domain.remember(makeFact({ workspacePath: WS, text: 'ci uses pnpm', updatedAt: now - 1000 }))
    await domain.remember(makeFact({ workspacePath: WS, text: 'no match here', updatedAt: now }))

    const ranked = domain.recall(WS, 'ci')
    expect(ranked.map(fact => fact.text)).toEqual([
      'unrelated note',        // exact tag ×3 (curated routing wins)
      'ci uses pnpm',          // text substring ×2, newest
      'the ci pipeline is slow', // text substring ×2, older
    ])

    // Deterministic: same input, same order.
    expect(domain.recall(WS, 'ci').map(fact => fact.id)).toEqual(ranked.map(fact => fact.id))

    // Empty query: newest active facts only.
    const all = domain.recall(WS)
    expect(all[0]?.text).toBe('no match here')
    expect(all).toHaveLength(4)
  })

  it('recall is case-insensitive and boosts the whole query as one substring', async () => {
    const { domain } = await bootMemory()
    await domain.remember(makeFact({ workspacePath: WS, text: 'the Release Verification runs from the web session' }))
    await domain.remember(makeFact({ workspacePath: WS, text: 'release and verification are separate words here' }))
    const ranked = domain.recall(WS, 'release verification')
    // Whole-phrase substring (×4 + token hits) beats scattered token hits.
    expect(ranked[0]?.text).toContain('runs from the web session')
  })

  it('recall tokenizes CJK runs into whole runs plus bigrams, and splits mixed runs', async () => {
    const { domain } = await bootMemory()
    await domain.remember(makeFact({ workspacePath: WS, text: '交互验证约定:发布验证走 web 会话人工审批' }))
    await domain.remember(makeFact({ workspacePath: WS, text: 'ci 管道使用 pnpm', tags: ['ci'] }))
    // Bigram "验证" from the query run "交互验证" matches the CJK fact.
    expect(domain.recall(WS, '交互验证')[0]?.text).toContain('发布验证走')
    // The ASCII run "ci" extracted from a mixed word matches the tag.
    expect(domain.recall(WS, 'ci交互')[0]?.text).toContain('pnpm')
  })

  it('archive is a soft delete: row stays, listActive drops it, double-archive is false', async () => {
    const { domain } = await bootMemory()
    const fact = await domain.remember(makeFact({ workspacePath: WS }))
    expect(await domain.archive(WS, fact.id)).toBe(true)
    expect(domain.getFact(WS, fact.id)?.state).toBe('archived')
    expect(await domain.archive(WS, fact.id)).toBe(false)
    expect(domain.listActive(WS)).toEqual([])
  })

  it('exact-cwd authorization: foreign rows are unreachable by id or path', async () => {
    const { domain } = await bootMemory()
    const foreign = await domain.remember(makeFact({ workspacePath: OTHER, text: 'secret' }))
    expect(domain.getFact(WS, foreign.id)).toBeUndefined()
    expect(await domain.archive(WS, foreign.id)).toBe(false)
    expect(domain.listActive(WS)).toEqual([])
    expect(domain.getProfile(OTHER).entries).toEqual([])
  })

  it('profile round-trips with entry caps enforced', async () => {
    const { domain } = await bootMemory({ maxProfileEntries: 2, maxProfileEntryChars: 6 })
    const next = await domain.putProfile({
      workspacePath: WS,
      entries: ['alpha', 'beta'],
      updatedAt: 0,
    })
    expect(domain.getProfile(WS).entries).toEqual(['alpha', 'beta'])
    expect(next.updatedAt).toBeGreaterThan(0)

    await expect(domain.putProfile({ workspacePath: WS, entries: ['a', 'b', 'c'], updatedAt: 0 }))
      .rejects.toMatchObject({ code: 'MEMORY_CAP_EXCEEDED' })
    await expect(domain.putProfile({ workspacePath: WS, entries: ['toolong'], updatedAt: 0 }))
      .rejects.toMatchObject({ code: 'MEMORY_CAP_EXCEEDED' })

    // Empty-string entries are dropped (the removal idiom).
    const cleaned = await domain.putProfile({ workspacePath: WS, entries: [' ', 'kept'], updatedAt: 0 })
    expect(cleaned.entries).toEqual(['kept'])
  })

  it('fails loud on a version-mismatched medium', async () => {
    const pool = new MemoryMediaPool()
    pool.versions.set('dsh_memory', MEMORY_DOMAIN_VERSION + 99)
    const ctx = new Context()
    await ctx.plugin(Storage)
    const backend = new MemoryStorageBackend(pool)
    ctx.storage.backend.register('memory', backend)
    const facility = new DomainFacility(ctx, { backend: 'memory' })
    ctx.storage.mount('domain', facility)
    await expect(
      openMemoryDomain(facility as unknown as StorageDomainFacility, resolveConfig()),
    ).rejects.toMatchObject({ name: 'StorageError', code: 'version-mismatch' })
  })
describe('consolidation suggestions', () => {
  it('flags near-duplicate facts by token overlap and skips distinct ones', () => {
    const a = makeFact({ text: 'the release verification runs from the web session' })
    const b = makeFact({ text: 'release verification runs in the web session' })
    const c = makeFact({ text: 'tests run with pnpm test' })
    const candidates = suggestConsolidations([a, b, c])
    expect(candidates).toHaveLength(1)
    expect(new Set([candidates[0]?.a.id, candidates[0]?.b.id])).toEqual(new Set([a.id, b.id]))
    expect(candidates[0]?.similarity).toBeGreaterThanOrEqual(0.55)
    expect(candidates[0]?.suggestedText).toContain('runs from the web session')
  })

  it('is deterministic and capped', () => {
    const facts = Array.from({ length: 12 }, (_, i) =>
      makeFact({ text: `shared common base wording number ${i}` }))
    const candidates = suggestConsolidations(facts)
    expect(candidates.length).toBeLessThanOrEqual(5)
    const again = suggestConsolidations(facts)
    expect(candidates.map(c => `${c.a.id}:${c.b.id}`)).toEqual(again.map(c => `${c.a.id}:${c.b.id}`))
  })

  it('tokenizes CJK bigrams for similarity', () => {
    const tokens = factTokens('交互验证约定')
    expect(tokens.has('验证')).toBe(true)
    expect(tokens.has('互验')).toBe(true)
  })
})

})
