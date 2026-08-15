// Model-facing memory tools.
//
// Tool registration is the standard ctx.tools.register (host registry, layered
// per scope). Verified contract (packages/core/tools/src/index.ts):
//
//   ToolDefinition: {
//     name, description, parameters (JSON Schema),
//     output: { schema: JsonSchemaNode, render(args, value): ContentBlock[] },
//     execute(args, exec: ToolRunContext): Promise<unknown>,
//   }
//
// Tool set (six tools — the design §5 list):
//
//   memory_remember  (write, approval-gated) — add or update one fact (or one
//                    workspace profile entry) in the caller's workspace.
//   memory_edit      (write, approval-gated) — replace one fact's text/tags/kind.
//   memory_forget    (write, approval-gated) — archive one fact (soft delete).
//   memory_recall    (read, never gated)     — bounded deterministic scan over
//                    active facts of the caller's workspace (text + tags).
//   memory_search    (read, never gated)     — FTS over past sessions via
//                    ctx.sessionQuery.searchSessions, exact-cwd authorized.
//   memory_profile   (read, never gated)     — show the caller's workspace
//                    profile and how to propose changes (writes go through
//                    memory_remember).
//
// Workspace authorization: every tool resolves the caller's workspace from
// `exec.agent.session.header.cwd` — never from arguments — and the domain
// layer scopes every read/write by that exact path (the same exact-cwd rule
// dsh-tool-session-query applies).

import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { z } from 'zod'

import type { ApprovalGate } from './approval.ts'
import type { ConfigType } from './config.ts'
import type { Fact, MemoryDomain } from './domain.ts'
import { MemoryError, hasCode } from './errors.ts'
import type { CallerAgent, SessionQueryServiceLike, ToolExec } from './types.ts'

/** Handle assembled in src/index.ts and shared by the registration layers. */
export interface MemoryService {
  readonly config: ConfigType
  /** Storage facility present at plugin mount (absent in headless profiles). */
  readonly storageDomainAvailable: boolean
  /** Resolve the memory domain, opening it lazily on first demand. */
  getDomain(): Promise<MemoryDomain>
  /** Already-open handle, or undefined — never opens. */
  openedDomain(): MemoryDomain | undefined
  /** Kick the lazy open (prompt section); the result is discarded. */
  ensureDomain(): void
  readonly approvalGate: ApprovalGate
  readonly sessionQuery: SessionQueryServiceLike | undefined
}

// ---------------------------------------------------------------------------
// Small shared helpers.

/** Standard string output projection for every memory tool. */
const TEXT_OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

interface Caller {
  readonly agent: CallerAgent
  readonly cwd: string
  readonly sessionId: string
  /** Log position the next event (this tool result) lands at. */
  readonly seq: number
}

function callerOf(exec: ToolExec): Caller {
  const agent = exec.agent
  if (agent === undefined) {
    throw new MemoryError('MEMORY_MISSING_AGENT', 'memory tools require an agent-bound caller')
  }
  const cwd = agent.session.header.cwd
  if (cwd === undefined || cwd.length === 0) {
    throw new MemoryError(
      'MEMORY_UNAUTHORIZED',
      'this session has no workspace cwd; per-workspace memory needs a workspace-scoped session',
    )
  }
  return { agent, cwd, sessionId: agent.session.id, seq: agent.session.events.length }
}

function parseArgs<S extends z.ZodType>(schema: S, raw: unknown, tool: string): z.infer<S> {
  const result = schema.safeParse(raw)
  if (!result.success) {
    throw new MemoryError('MEMORY_INVALID_ARGS', `${tool}: ${z.prettifyError(result.error)}`)
  }
  return result.data
}

function truncate(text: string, max: number): string {
  return [...text].length <= max ? text : `${[...text].slice(0, max).join('')}…`
}

function iso(millis: number): string {
  return new Date(millis).toISOString()
}

/** The ask's human-readable WHY — what would be written, for the approver. */
function writeReason(verb: string, cwd: string, detail: string): string {
  return `${verb} in workspace memory (${basename(cwd) || cwd}): ${detail}`
}

async function approveWrite(
  service: MemoryService,
  exec: ToolExec,
  caller: Caller,
  toolName: string,
  reason: string,
): Promise<void> {
  const allowed = await service.approvalGate.request({
    agent: caller.agent,
    toolName,
    callId: exec.callId,
    reason,
    signal: exec.signal,
  })
  if (!allowed) {
    throw new MemoryError(
      'MEMORY_APPROVAL_DENIED',
      `${toolName}: the human did not approve this memory write — nothing was stored (writes fail closed)`,
    )
  }
}

async function openDomain(service: MemoryService): Promise<MemoryDomain> {
  try {
    return await service.getDomain()
  } catch (error) {
    if (error instanceof MemoryError) throw error
    const code = hasCode(error, 'version-mismatch') || hasCode(error, 'backend-not-found')
      ? (error as { code: string }).code
      : undefined
    throw new MemoryError(
      'MEMORY_UNAVAILABLE',
      `memory domain could not be opened${code === undefined ? '' : ` (${code})`}: ${String(error)}`
      + ' — memory is offline until this is fixed',
      { cause: error },
    )
  }
}

/** Render one fact as a compact recall line. */
function factLine(fact: Fact): string {
  const tags = fact.tags.length > 0 ? ` (tags: ${fact.tags.join(', ')})` : ''
  return `- ${fact.id} [${fact.kind}] ${truncate(fact.text, 400)}${tags} — updated ${iso(fact.updatedAt)}`
}

// ---------------------------------------------------------------------------
// Argument schemas (tools validate their own input).

const rememberArgs = z.object({
  /**
   * Information-dense text; required for both facts and profile entries.
   * Empty is allowed syntactically: with target:"profile" and a profile_index
   * it DROPS that entry; the fact path rejects empty text explicitly.
   */
  text: z.string(),
  /** Fact category; profile entries ignore it. */
  kind: z.enum(['preference', 'fact', 'convention', 'decision']).optional(),
  tags: z.array(z.string()).optional(),
  /** Update the fact with this id instead of adding one. */
  id: z.string().min(1).optional(),
  /** Write a fact (default) or one workspace profile entry. */
  target: z.enum(['fact', 'profile']).default('fact'),
  /** Profile only: replace entry at this 0-based index (append when omitted or equal to the entry count). */
  profile_index: z.number().int().min(0).optional(),
})

const editArgs = z.object({
  id: z.string().min(1),
  text: z.string().min(1).optional(),
  kind: z.enum(['preference', 'fact', 'convention', 'decision']).optional(),
  tags: z.array(z.string()).optional(),
})

const forgetArgs = z.object({
  id: z.string().min(1),
})

const recallArgs = z.object({
  query: z.string().optional(),
  limit: z.number().int().min(1).max(50).optional(),
})

const searchArgs = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(20).optional(),
})

const profileArgs = z.object({})

// ---------------------------------------------------------------------------

/** Register all six tools; returns the composite disposer. */
export function registerMemoryTools(ctx: Context, service: MemoryService): () => void {
  return ctx.effect(() => {
    const disposers: Array<() => void> = [
      ctx.tools.register({
        name: 'memory_remember',
        description:
          `Add or update one fact (or one workspace profile entry) in this workspace's long-term memory. `
          + `Facts: text ≤ ${service.config.maxFactChars} chars, ≤ ${service.config.maxFactsPerWorkspace} active facts per workspace `
          + `(consolidate with memory_edit / memory_forget when full); kind ∈ preference|fact|convention|decision; `
          + `omit 'id' to add, pass a recalled id to update. Profile: target:"profile" writes one entry (≤ `
          + `${service.config.maxProfileEntryChars} chars, ≤ ${service.config.maxProfileEntries} entries; profile_index replaces, `
          + `empty text with profile_index drops). Writes require human approval.`,
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'Information-dense memory text (required)' },
            kind: { type: 'string', enum: ['preference', 'fact', 'convention', 'decision'], description: 'Fact category (facts only)' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Routing tags; recall matches text first, tags second' },
            id: { type: 'string', description: 'Existing fact id to update instead of adding' },
            target: { type: 'string', enum: ['fact', 'profile'], description: 'Write a fact or a workspace profile entry' },
            profile_index: { type: 'integer', minimum: 0, description: 'Profile entry index to replace (omit to append)' },
          },
          required: ['text'],
        },
        output: TEXT_OUTPUT,
        execute: async (rawArgs, exec) => {
          const caller = callerOf(exec as ToolExec)
          const args = parseArgs(rememberArgs, rawArgs, 'memory_remember')
          const domain = await openDomain(service)

          if (args.target === 'profile') {
            const reason = writeReason('Update the workspace profile', caller.cwd, truncate(args.text, 120))
            await approveWrite(service, exec as ToolExec, caller, 'memory_remember', reason)
            const profile = domain.getProfile(caller.cwd)
            const entries = [...profile.entries]
            const index = args.profile_index ?? entries.length
            if (index > entries.length) {
              throw new MemoryError(
                'MEMORY_INVALID_ARGS',
                `memory_remember: profile_index ${index} is beyond the ${entries.length} profile entries`,
              )
            }
            if (args.text.trim().length === 0) {
              if (index === entries.length) {
                throw new MemoryError('MEMORY_INVALID_ARGS', 'memory_remember: no profile entry at the append position to drop')
              }
              entries.splice(index, 1)
            } else {
              entries[index] = args.text
            }
            const next = await domain.putProfile({ workspacePath: caller.cwd, entries, updatedAt: Date.now() })
            return `workspace profile updated: ${next.entries.length} entries`
          }

          const existing = args.id === undefined ? undefined : domain.getFact(caller.cwd, args.id)
          if (args.id !== undefined && existing === undefined) {
            throw new MemoryError('MEMORY_NOT_FOUND', `memory_remember: no fact '${args.id}' in this workspace`)
          }
          if (args.text.trim().length === 0) {
            throw new MemoryError(
              'MEMORY_INVALID_ARGS',
              'memory_remember: fact text must not be empty (empty text only drops a profile entry, with target:"profile")',
            )
          }
          const now = Date.now()
          const fact: Fact = {
            id: existing?.id ?? randomUUID(),
            workspacePath: caller.cwd,
            kind: args.kind ?? existing?.kind ?? 'fact',
            text: args.text,
            tags: args.tags ?? existing?.tags ?? [],
            sessionId: caller.sessionId,
            seq: caller.seq,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
            state: 'active',
          }
          const reason = writeReason(`Store ${fact.kind} fact`, caller.cwd, truncate(fact.text, 120))
          await approveWrite(service, exec as ToolExec, caller, 'memory_remember', reason)
          const stored = await domain.remember(fact)
          return `stored fact ${stored.id} [${stored.kind}] — cited to session ${stored.sessionId}#${stored.seq}`
        },
      }),

      ctx.tools.register({
        name: 'memory_edit',
        description:
          `Replace one fact's text, kind, or tags (workspace-scoped; needs the fact id from memory_recall). `
          + `Text ≤ ${service.config.maxFactChars} chars. Requires human approval.`,
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Fact id to edit' },
            text: { type: 'string', description: 'Replacement text' },
            kind: { type: 'string', enum: ['preference', 'fact', 'convention', 'decision'] },
            tags: { type: 'array', items: { type: 'string' } },
          },
          required: ['id'],
        },
        output: TEXT_OUTPUT,
        execute: async (rawArgs, exec) => {
          const caller = callerOf(exec as ToolExec)
          const args = parseArgs(editArgs, rawArgs, 'memory_edit')
          if (args.text === undefined && args.kind === undefined && args.tags === undefined) {
            throw new MemoryError('MEMORY_INVALID_ARGS', 'memory_edit: provide at least one of text, kind, or tags')
          }
          const domain = await openDomain(service)
          const existing = domain.getFact(caller.cwd, args.id)
          if (existing === undefined) {
            throw new MemoryError('MEMORY_NOT_FOUND', `memory_edit: no fact '${args.id}' in this workspace`)
          }
          const next: Fact = {
            ...existing,
            text: args.text ?? existing.text,
            kind: args.kind ?? existing.kind,
            tags: args.tags ?? existing.tags,
            sessionId: caller.sessionId,
            seq: caller.seq,
            updatedAt: Date.now(),
          }
          const reason = writeReason(`Edit fact ${next.id}`, caller.cwd, truncate(next.text, 120))
          await approveWrite(service, exec as ToolExec, caller, 'memory_edit', reason)
          const stored = await domain.remember(next)
          return `edited fact ${stored.id} — cited to session ${stored.sessionId}#${stored.seq}`
        },
      }),

      ctx.tools.register({
        name: 'memory_forget',
        description:
          'Archive one fact by id (soft delete — provenance stays in the session log; recall no longer returns it). Requires human approval.',
        parameters: {
          type: 'object',
          properties: { id: { type: 'string', description: 'Fact id to archive' } },
          required: ['id'],
        },
        output: TEXT_OUTPUT,
        execute: async (rawArgs, exec) => {
          const caller = callerOf(exec as ToolExec)
          const args = parseArgs(forgetArgs, rawArgs, 'memory_forget')
          const domain = await openDomain(service)
          const existing = domain.getFact(caller.cwd, args.id)
          if (existing === undefined || existing.state === 'archived') {
            throw new MemoryError('MEMORY_NOT_FOUND', `memory_forget: no active fact '${args.id}' in this workspace`)
          }
          const reason = writeReason(`Forget fact ${existing.id} [${existing.kind}]`, caller.cwd, truncate(existing.text, 120))
          await approveWrite(service, exec as ToolExec, caller, 'memory_forget', reason)
          const archived = await domain.archive(caller.cwd, args.id)
          if (!archived) {
            throw new MemoryError('MEMORY_NOT_FOUND', `memory_forget: fact '${args.id}' vanished before the write landed`)
          }
          return `archived fact ${args.id}`
        },
      }),

      ctx.tools.register({
        name: 'memory_recall',
        description:
          'Deterministic scan over this workspace\'s active facts: text matches rank first, tags second, recency breaks ties. '
          + 'Pass a query to filter; omit it to list the newest facts.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Words to match against fact text and tags' },
            limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Maximum facts to return (default 20)' },
          },
        },
        output: TEXT_OUTPUT,
        execute: async (rawArgs, exec) => {
          const caller = callerOf(exec as ToolExec)
          const args = parseArgs(recallArgs, rawArgs, 'memory_recall')
          const domain = await openDomain(service)
          const facts = domain.recall(caller.cwd, args.query, args.limit)
          if (facts.length === 0) {
            return args.query === undefined
              ? 'no active facts in this workspace yet'
              : `no active facts match ${JSON.stringify(args.query)} in this workspace`
          }
          return facts.map(factLine).join('\n')
        },
      }),

      ctx.tools.register({
        name: 'memory_search',
        description:
          'Full-text search over PAST sessions of this workspace (the durable session logs), returning the strongest matching '
          + 'event excerpt per session. Requires the full-text index enabled by this plugin\'s bundle patch. '
          + 'Use memory_recall for the curated facts table.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Full-text query, interpreted as data' },
            limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Maximum sessions to return (default 5)' },
          },
          required: ['query'],
        },
        output: TEXT_OUTPUT,
        timeoutMs: 30_000,
        execute: async (rawArgs, exec) => {
          const caller = callerOf(exec as ToolExec)
          const args = parseArgs(searchArgs, rawArgs, 'memory_search')
          if (service.sessionQuery === undefined) {
            throw new MemoryError('MEMORY_DISABLED', 'memory_search: the session-query service is not available in this profile')
          }
          try {
            const page = await service.sessionQuery.searchSessions({
              query: args.query,
              sessionFilters: [{ kind: 'cwd', values: [caller.cwd] }],
              limit: args.limit ?? 5,
            }, { signal: (exec as ToolExec).signal })
            const items = page.items ?? []
            if (items.length === 0) {
              return `no prior-session matches for ${JSON.stringify(args.query)} in this workspace`
            }
            return items.map((hit, index) => {
              const created = hit.header.createdAt === undefined ? '' : `, ${iso(hit.header.createdAt)}`
              const snippet = truncate(hit.bestMatch?.snippet ?? '', 400)
              return `${index + 1}. session ${hit.header.id}${created}: ${snippet}`
            }).join('\n')
          } catch (error) {
            if (hasCode(error, 'SESSION_QUERY_SEARCH_DISABLED')) {
              throw new MemoryError(
                'SESSION_QUERY_SEARCH_DISABLED',
                'memory_search: session full-text search is disabled (SESSION_QUERY_SEARCH_DISABLED) — '
                + 'the FTS backend is not open; enable the bundle patch\'s openAt: first-search or use memory_recall',
                { cause: error },
              )
            }
            throw new MemoryError(
              'MEMORY_UNAVAILABLE',
              `memory_search failed: ${String(error)}`,
              { cause: error },
            )
          }
        },
      }),

      ctx.tools.register({
        name: 'memory_profile',
        description:
          'Show this workspace\'s always-injected profile (the bounded notes injected into every session prompt) and how to change it. '
          + 'Read-only: changes land through memory_remember (target:"profile"), which asks the human.',
        parameters: { type: 'object', properties: {} },
        output: TEXT_OUTPUT,
        execute: async (rawArgs, exec) => {
          const caller = callerOf(exec as ToolExec)
          parseArgs(profileArgs, rawArgs, 'memory_profile')
          const domain = await openDomain(service)
          const profile = domain.getProfile(caller.cwd)
          const max = service.config.maxProfileEntries
          const header = `Workspace profile: ${profile.entries.length}/${max} entries`
          if (profile.entries.length === 0) return `${header} (empty)`
          const body = profile.entries.map((entry, index) => `${index}. ${entry}`).join('\n')
          return `${header}\n${body}\n\nUpdate with memory_remember: target:"profile", profile_index:<n> to replace entry n, `
            + `empty text to drop it, or omit profile_index to append.`
        },
      }),
    ]

    return () => {
      for (const dispose of disposers) dispose()
    }
  })
}
