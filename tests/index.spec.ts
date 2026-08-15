// Plugin entry tests: degradation paths (no storageDomain / no sessionQuery),
// lazy domain open, approval fail-closed, config parsing, and full teardown.

import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { describe, expect, it, vi } from 'vitest'

import type { StorageDomainFacility } from '../src/domain.ts'
import { apply } from '../src/index.ts'
import type { ToolExec } from '../src/types.ts'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'

interface RegisteredTool {
  name: string
  description: string
  execute(args: unknown, exec: ToolExec): Promise<unknown>
}

interface FakeCtx {
  effect(cb: () => () => void): () => void
  get(name: string): unknown
  on(name: string, listener: unknown): unknown
  tools: { register(definition: RegisteredTool): () => void }
  logger(name: string): { warn(...args: unknown[]): void }
  defs: Map<string, RegisteredTool>
  sections: unknown[]
}

function fakeCtx(options: { storageDomain?: unknown; approval?: unknown } = {}) {
  const defs = new Map<string, RegisteredTool>()
  const sections: unknown[] = []
  const fake: FakeCtx = {
    effect: cb => cb(),
    on: () => {},
    get: (name: string) => {
      if (name === 'storageDomain') return options.storageDomain
      if (name === 'approval') return options.approval
      if (name === 'systemPrompt') {
        return {
          section: (section: unknown) => {
            sections.push(section)
            return () => {
              const index = sections.indexOf(section)
              if (index >= 0) sections.splice(index, 1)
            }
          },
        }
      }
      return undefined
    },
    tools: {
      register: (definition) => {
        defs.set(definition.name, definition)
        return () => {
          defs.delete(definition.name)
        }
      },
    },
    logger: () => ({ warn: vi.fn() }),
    defs,
    sections,
  }
  return { raw: fake, ctx: fake as unknown as Context, defs, sections }
}

const exec = (cwd: string): ToolExec => ({
  callId: 'call-1',
  agent: { session: { id: 'sess', header: { cwd }, events: [1] } },
  signal: new AbortController().signal,
})

describe('plugin entry', () => {
  it('stays mounted without a storageDomain and memory tools answer MEMORY_DISABLED', () => {
    const { ctx, defs } = fakeCtx()
    apply(ctx, {})
    expect(defs.size).toBe(9)
    return expect(defs.get('memory_remember')!.execute({ text: 'x' }, exec('/ws')))
      .rejects.toMatchObject({ name: 'MemoryError', code: 'MEMORY_DISABLED' })
  })

  it('injectProfile: false omits the prompt section; true (default) registers it', () => {
    const off = fakeCtx()
    apply(off.ctx, { injectProfile: false })
    expect(off.sections).toHaveLength(0)

    const on = fakeCtx()
    apply(on.ctx, {})
    expect(on.sections).toHaveLength(1)
  })

  it('opens the domain lazily on first use and reuses the handle', async () => {
    const pool = new MemoryMediaPool()
    const backend = new MemoryStorageBackend(pool)
    const ctx = new Context()
    await ctx.plugin(Storage)
    ctx.storage.backend.register('memory', backend)
    const facility = new DomainFacility(ctx, { backend: 'memory' })
    ctx.storage.mount('domain', facility)

    let opens = 0
    const counting: StorageDomainFacility = {
      open: (spec) => {
        opens += 1
        return facility.open(spec as never)
      },
    }
    const { ctx: fake, defs } = fakeCtx({ storageDomain: counting })
    apply(fake, { approvalWrites: false })

    await defs.get('memory_remember')!.execute({ text: 'first' }, exec('/ws'))
    await defs.get('memory_remember')!.execute({ text: 'second' }, exec('/ws'))
    expect(opens).toBe(1)
    // Both facts are durable on the medium (the pool simulates the unit file).
    expect(pool.media.get('dsh_memory')?.tables.get('facts')?.size).toBe(2)
  })

  it('writes fail closed when approval is absent and approvalWrites defaults to true', async () => {
    const pool = new MemoryMediaPool()
    const ctx = new Context()
    await ctx.plugin(Storage)
    ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
    const facility = new DomainFacility(ctx, { backend: 'memory' })
    ctx.storage.mount('domain', facility)

    const { ctx: fake, defs } = fakeCtx({ storageDomain: facility })
    apply(fake, {})
    await expect(defs.get('memory_remember')!.execute({ text: 'x' }, exec('/ws')))
      .rejects.toMatchObject({ name: 'MemoryError', code: 'MEMORY_APPROVAL_DENIED' })
  })

  it('config caps flow into the tool descriptions', () => {
    const { ctx, defs } = fakeCtx()
    apply(ctx, { maxFactChars: 1234 })
    expect(defs.get('memory_remember')?.description).toContain('1234')
  })

  it('teardown disposes registrations and closes an opened domain', async () => {
    const pool = new MemoryMediaPool()
    const ctx = new Context()
    await ctx.plugin(Storage)
    ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
    const facility = new DomainFacility(ctx, { backend: 'memory' })
    ctx.storage.mount('domain', facility)

    const { raw, ctx: fake, defs, sections } = fakeCtx({ storageDomain: facility })
    // Capture the OUTERMOST effect (apply's) disposer; each nested effect
    // gets its own correctly-scoped disposer, like real ctx.effect.
    let depth = 0
    let outerTeardown: (() => Promise<void>) | undefined
    raw.effect = (cb: () => () => void | Promise<void>) => {
      depth += 1
      const inner = cb()
      depth -= 1
      const disposer = async () => {
        await inner()
      }
      // Nested effects run synchronously inside the outer cb, so the call
      // that returns to depth 0 is apply's own effect.
      if (outerTeardown === undefined && depth === 0) outerTeardown = disposer
      return disposer
    }
    apply(fake, { approvalWrites: false })

    await defs.get('memory_remember')!.execute({ text: 'persisted' }, exec('/ws'))
    expect(defs.size).toBe(9)
    expect(sections).toHaveLength(1)
    await outerTeardown?.()
    expect(defs.size).toBe(0)
    expect(sections).toHaveLength(0)
    // The domain released its name: reopening the same unit succeeds.
    const reopened = new DomainFacility(ctx, { backend: 'memory' })
    await expect(reopened.open({ name: 'dsh_memory', version: 1, tables: {} } as never)).resolves.toBeDefined()
  })
})
