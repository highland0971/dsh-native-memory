// Read-only browser facts route over the harness web server (v0.3.0).
//
// Verified contract (packages/host/webserver/lib/types/index.d.ts):
//
//   webServer.register(route: WebRoute): () => void
//   WebRoute: { kind: 'exact' | 'prefix', path (absolute, no trailing slash),
//               handler(req: IncomingMessage, res: ServerResponse) }
//
// The handler owns the full response lifecycle; configured routes must be
// distinct. The client half's settings page calls GET /dsh-native-memory/facts.
//
// The page is READ-ONLY by design: the approval service refuses requests
// outside an open turn (packages/interaction/user-approval/src/index.ts:261),
// and a web request carries no agent — so a browser-initiated delete cannot
// legally ride the approval gate. Deletions therefore stay in the chat: the
// page copies a `memory_forget id: "…"` instruction, and the tool's own
// approval gate does the human check. Secrets are masked server-side — the
// browser never receives stored secret text verbatim.

import type { Context } from '@deepseek-ai/cordis'
import { basename } from 'node:path'

import type { MemoryDomain } from './domain.ts'
import { maskSecrets } from './redaction.ts'
import type { MemoryService } from './tools.ts'

/** Minimal structural view of the node:http ServerResponse surface we use. */
export interface WebResponse {
  statusCode: number
  setHeader(name: string, value: string): void
  end(body: string): void
}

/** Minimal structural view of the webServer service register surface. */
export interface WebServerLike {
  register(route: {
    readonly kind: 'exact'
    readonly path: string
    readonly handler: (req: { readonly method?: string }, res: WebResponse) => Promise<void>
  }): () => void
}

function sendJson(res: WebResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

/** Serve the facts list; exported pure for tests. */
export async function handleFactsRequest(service: MemoryService, res: WebResponse): Promise<void> {
  let domain: MemoryDomain
  try {
    domain = await service.getDomain()
  } catch (error) {
    sendJson(res, 503, { error: `memory is offline: ${String(error instanceof Error ? error.message : error)}` })
    return
  }
  const facts = domain.listAllActive().map(fact => ({
    id: fact.id,
    kind: fact.kind,
    text: maskSecrets(fact.text),
    tags: fact.tags,
    workspace: basename(fact.workspacePath) || fact.workspacePath,
    updatedAt: fact.updatedAt,
    accessCount: fact.accessCount ?? 0,
    sessionId: fact.sessionId,
    seq: fact.seq,
  }))
  sendJson(res, 200, { facts })
}

/**
 * Register the read-only route on the optional webServer service. Returns the
 * disposer (fiber-bound — stop/update removes the route), or undefined when
 * the profile has no webServer (headless).
 */
export function registerFactsRoute(ctx: Context, service: MemoryService): (() => void) | undefined {
  const webServer = ctx.get('webServer') as WebServerLike | undefined
  if (webServer === undefined) return undefined
  return ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/dsh-native-memory/facts',
    handler: async (req, res) => {
      try {
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: 'method not allowed (read-only page)' })
          return
        }
        await handleFactsRequest(service, res)
      } catch (error) {
        sendJson(res, 500, { error: String(error instanceof Error ? error.message : error) })
      }
    },
  }))
}
