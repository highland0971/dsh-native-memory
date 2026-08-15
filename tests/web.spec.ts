// Read-only facts route tests: GET serves masked facts across workspaces
// (newest first, archived excluded); the route wrapper answers 405 for
// non-GET; an offline domain answers 503; registration is fiber-bound and
// the disposer unregisters.

import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'

import type { MemoryService } from '../src/tools.ts'
import { handleFactsRequest, registerFactsRoute } from '../src/web.ts'
import type { WebResponse } from '../src/web.ts'
import { bootMemory, makeFact } from './helpers/harness.ts'
import type { MemoryHarness } from './helpers/harness.ts'

const WS = '/home/user/project'
const OTHER = '/home/user/other'

function fakeRes(): { statusCode: number; headers: Record<string, string>; body: string } & WebResponse {
  const res: { statusCode: number; headers: Record<string, string>; body: string } & WebResponse = {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(name: string, value: string) {
      res.headers[name] = value
    },
    end(body: string) {
      res.body = body
    },
  }
  return res
}

function webService(harness: MemoryHarness): MemoryService {
  return {
    config: harness.config,
    storageDomainAvailable: true,
    getDomain: async () => harness.domain,
    openedDomain: () => harness.domain,
    ensureDomain: () => {},
    approvalGate: { request: async () => true },
    sessionQuery: undefined,
  }
}

describe('facts web route', () => {
  it('serves active facts across workspaces, newest first, secrets masked', async () => {
    const harness = await bootMemory({ secretPolicy: 'off' })
    const secret = `ghp_${'a'.repeat(36)}`
    const older = await harness.domain.remember(makeFact({ workspacePath: WS, text: `old token ${secret}`, updatedAt: 1 }))
    const newer = await harness.domain.remember(makeFact({ workspacePath: OTHER, text: 'other workspace fact', updatedAt: 2 }))
    const archived = await harness.domain.remember(makeFact({ workspacePath: WS, text: 'archived', updatedAt: 3 }))
    await harness.domain.archive(WS, archived.id)

    const res = fakeRes()
    await handleFactsRequest(webService(harness), res)
    expect(res.statusCode).toBe(200)
    expect(res.headers['Content-Type']).toContain('application/json')
    const payload = JSON.parse(res.body) as {
      facts: Array<{ id: string; text: string; workspace: string; accessCount: number }>
    }
    expect(payload.facts.map(fact => fact.id)).toEqual([newer.id, older.id])
    expect(payload.facts.find(fact => fact.id === older.id)?.text).toContain('[REDACTED]')
    expect(payload.facts.find(fact => fact.id === older.id)?.text).not.toContain('ghp_')
    expect(payload.facts.find(fact => fact.id === newer.id)?.workspace).toBe('other')
    expect(payload.facts.find(fact => fact.id === older.id)?.accessCount).toBe(0)
  })

  it('answers 503 when the domain cannot open', async () => {
    const harness = await bootMemory()
    const service = webService(harness)
    service.getDomain = async () => {
      throw new Error('version-mismatch')
    }
    const res = fakeRes()
    await handleFactsRequest(service, res)
    expect(res.statusCode).toBe(503)
    expect(JSON.parse(res.body).error).toContain('memory is offline')
  })

  it('registers an exact GET route and its disposer unregisters; non-GET is 405', async () => {
    const harness = await bootMemory()
    const unregister = vi.fn()
    const registered: Array<{
      kind: string
      path: string
      handler: (req: { method?: string }, res: WebResponse) => Promise<void>
    }> = []
    const ctx = {
      get: () => ({ register: (route: (typeof registered)[number]) => { registered.push(route); return unregister } }),
      effect: (cb: () => () => void) => cb(),
    }
    const dispose = registerFactsRoute(ctx as unknown as Context, webService(harness))
    expect(dispose).toBeDefined()
    expect(registered).toHaveLength(1)
    expect(registered[0]).toMatchObject({ kind: 'exact', path: '/dsh-native-memory/facts' })

    const resPost = fakeRes()
    await registered[0]!.handler({ method: 'POST' }, resPost)
    expect(resPost.statusCode).toBe(405)

    const resGet = fakeRes()
    await registered[0]!.handler({ method: 'GET' }, resGet)
    expect(resGet.statusCode).toBe(200)

    dispose?.()
    expect(unregister).toHaveBeenCalledTimes(1)
  })
})
