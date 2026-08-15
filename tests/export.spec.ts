// Markdown export mirror tests: the pure render masks secrets and carries
// citations; the writer is idempotent (content-addressed) and atomic; the
// memory_export tool writes into the caller's workspace without any
// approval ask.

import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'


import { describe, expect, it } from 'vitest'

import { EXPORT_DIR, EXPORT_FILE, renderExport, writeExport } from '../src/export.ts'
import { bootMemory, makeFact } from './helpers/harness.ts'
import { registerMemoryTools } from '../src/tools.ts'
import type { MemoryService } from '../src/tools.ts'
import type { ToolExec } from '../src/types.ts'
import type { Context } from '@deepseek-ai/cordis'

const WS = '/home/user/project'

/** Temp dir under the workspace .tmp (created on demand — CI checkouts lack it). */
async function tempDir(prefix: string): Promise<string> {
  const base = join(process.cwd(), '.tmp')
  await mkdir(base, { recursive: true })
  return mkdtemp(join(base, prefix))
}

describe('renderExport', () => {
  it('renders masked facts with citations and the profile section', () => {
    const secret = `ghp_${'a'.repeat(36)}`
    const facts = [
      makeFact({ workspacePath: WS, kind: 'convention', text: `token ${secret}`, tags: ['cred'], sessionId: 's1', seq: 7, updatedAt: 1_700_000_000_000 }),
    ]
    const profile = { workspacePath: WS, entries: [`pwd is ${secret}`], updatedAt: 1 }
    const text = renderExport(facts, profile)
    expect(text).toContain('# Workspace memory — dsh-native-memory export')
    expect(text).toContain('NOT synced back')
    expect(text).toContain('## Facts (1)')
    expect(text).toContain('[convention] token [REDACTED]')
    expect(text).not.toContain('ghp_')
    expect(text).toContain('session s1#7')
    expect(text).toContain('- pwd is [REDACTED]')
  })

  it('is deterministic: two renders of the same data are byte-identical', () => {
    const facts = [makeFact({ workspacePath: WS, text: 'ci uses pnpm', updatedAt: 1_700_000_000_000 })]
    const profile = { workspacePath: WS, entries: ['dense note'], updatedAt: 1 }
    expect(renderExport(facts, profile)).toBe(renderExport(facts, profile))
  })

  it('renders empty sections deterministically', () => {
    const text = renderExport([], { workspacePath: WS, entries: [], updatedAt: 0 })
    expect(text).toContain('(empty)')
    expect(text).toContain('## Facts (0)')
    expect(text).toContain('(none)')
  })
})

describe('writeExport', () => {
  it('writes atomically and skips rewriting identical content', async () => {
    const cwd = await tempDir('export-')
    try {
      const first = await writeExport(cwd, 'line one\n')
      expect(first.rewrote).toBe(true)
      expect(await readFile(join(cwd, EXPORT_DIR, EXPORT_FILE), 'utf8')).toBe('line one\n')
      const second = await writeExport(cwd, 'line one\n')
      expect(second.rewrote).toBe(false)
      const third = await writeExport(cwd, 'line two\n')
      expect(third.rewrote).toBe(true)
      expect(await readFile(join(cwd, EXPORT_DIR, EXPORT_FILE), 'utf8')).toBe('line two\n')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})

describe('memory_export tool', () => {
  it('exports the caller workspace without any approval ask', async () => {
    const harness = await bootMemory()
    await harness.domain.remember(makeFact({ workspacePath: WS, text: 'ci uses pnpm' }))
    const asks: Array<{ toolName: string }> = []
    const service: MemoryService = {
      config: harness.config,
      storageDomainAvailable: true,
      getDomain: async () => harness.domain,
      openedDomain: () => harness.domain,
      ensureDomain: () => {},
      approvalGate: { request: async (req) => { asks.push({ toolName: req.toolName }); return true } },
      sessionQuery: undefined,
    }
    const defs = new Map<string, { execute(args: unknown, exec: ToolExec): Promise<unknown> }>()
    const ctx = {
      effect: (cb: () => () => void) => cb(),
      tools: { register: (def: { name: string; execute(args: unknown, exec: ToolExec): Promise<unknown> }) => { defs.set(def.name, def); return () => {} } },
      get: () => undefined,
    }
    registerMemoryTools(ctx as unknown as Context, service)

    // Real workspace dir for the caller cwd (the tool writes inside it).
    const cwd = await tempDir('export-tool-')
    const exec: ToolExec = {
      callId: 'call-x',
      agent: { session: { id: 'sess-tool', header: { cwd }, events: [1] } },
      signal: new AbortController().signal,
    }
    try {
      const result = await defs.get('memory_export')!.execute({}, exec)
      expect(String(result)).toContain('exported 0 fact(s)')
      expect(String(result)).toContain(join(cwd, EXPORT_DIR, EXPORT_FILE))
      // The caller's workspace has no facts yet; the file still exists with
      // the profile + empty facts section, and no approval was asked.
      const content = await readFile(join(cwd, EXPORT_DIR, EXPORT_FILE), 'utf8')
      expect(content).toContain('## Facts (0)')
      expect(asks).toHaveLength(0)

      // Tool-level idempotency: the second call must skip the rewrite —
      // this catches any wall-clock leaking back into the rendered content.
      const second = await defs.get('memory_export')!.execute({}, exec)
      expect(String(second)).toContain('unchanged (idempotent skip)')
      expect(await readFile(join(cwd, EXPORT_DIR, EXPORT_FILE), 'utf8')).toBe(content)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
