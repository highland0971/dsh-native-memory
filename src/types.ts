// Structural views of the harness seams this plugin consumes.
//
// dsh-native-memory publishes a zero-runtime-import surface: the plugin code
// imports only `zod` at runtime, never a `@deepseek-ai/dsh-*` package. The
// interfaces below are the minimal structural contracts each seam guarantees,
// verified against deepseek-harness 0.2.0-rc.2 (commit 99f6f02) at the cited
// sources. The real services are duck-typed at runtime through `ctx.get`.
//
// Session API note (issue #39): the harness Session exposes `seq` — "the next
// event's sequence number — always the log length" — and NOT an `events`
// array (packages/core/session/src/index.ts:680-682, and no `get events` in
// 0.2.0-rc.2 nor 0.1.5-rc.2). Callers that need event content read it through
// `ctx.sessionQuery.readSession` (live-preferred) or `Session.deriveMessages()`.
//
// Type-only imports of the harness packages live in devDependencies so the
// module still typechecks against the published contracts; nothing below
// leaks into the emitted bundle.

/** The caller agent view threaded by the tool runtime (`ToolRunContext.agent`). */
export interface CallerAgent {
  readonly session: {
    /** Session identity (provenance + approval routing). */
    readonly id: string
    /** Session header; `cwd` is the exact workspace path authorization key. */
    readonly header: { readonly cwd?: string }
    /**
     * The seq the next event lands at — `Session.seq`, documented as "the next
     * event's sequence number — always the log length"
     * (packages/core/session/src/index.ts:680-682). This replaces the removed
     * `session.events.length` (issue #39).
     */
    readonly seq: number
  }
}

/** The tool execution view handed to `execute(args, exec)`. */
export interface ToolExec {
  /** Identity of the tool call, passed through to the approval ask. */
  readonly callId: unknown
  /** Agent on whose behalf the call runs (set by the agent loop). */
  readonly agent?: CallerAgent
  /** Caller-owned cancellation. */
  readonly signal: AbortSignal
}

/** Closed outcome vocabulary of the approval service. */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/**
 * `ctx.approval.request` — packages/interaction/user-approval/src/index.ts.
 * Only `'allowed-once'` grants the requested write; every other outcome fails
 * closed.
 */
export interface ApprovalServiceLike {
  request(req: {
    readonly agent: unknown
    readonly toolName: string
    readonly callId?: unknown
    readonly reason?: string
    readonly signal?: AbortSignal
  }): Promise<ApprovalOutcome>
}

/** One cross-session FTS hit (`SessionSearchHit`, session-query). */
export interface SessionSearchHitLike {
  readonly header: { readonly id: string; readonly createdAt?: number }
  readonly bestMatch?: { readonly snippet?: string }
}

/** One FTS result page (`SessionSearchPage`, session-query). */
export interface SessionSearchPageLike {
  readonly items?: readonly SessionSearchHitLike[]
}

/**
 * `ctx.sessionQuery.searchSessions` — packages/session-query/session-query.
 * The exact-cwd filter is how memory_search stays workspace-authorized: the
 * same rule dsh-tool-session-query's `session_search` applies.
 */
export interface SessionQueryServiceLike {
  searchSessions(
    req: {
      readonly query: string
      readonly sessionFilters?: readonly { readonly kind: string; readonly values: readonly string[] }[]
      readonly eventFilters?: readonly unknown[]
      readonly limit?: number
      readonly cursor?: unknown
    },
    exec?: { readonly signal?: AbortSignal },
  ): Promise<SessionSearchPageLike>
  /** Read one complete session log (live-preferred); used by memory_import. */
  readSession(sessionId: string): Promise<SessionLogSnapshotLike>
}

/**
 * One model-facing content block (structural view). Only `text` is read by
 * this plugin: 0.2.0-rc.2's `ContentBlockMap` carries text / reasoning / image
 * / file / tool-call / tool-addition / tool-removal, and the released
 * `tool-result` wrapper is refused outright by session format v4
 * (packages/llm/llm/src/types.ts:137-145,
 * packages/session/session-format-v3-to-v4/src/retired-syntax.ts:6-9).
 */
export interface SessionContentBlockLike {
  readonly type?: string
  readonly text?: string
}

/** One durable log event (structural view of SessionEvent's text surface). */
export interface SessionEventLike {
  readonly type?: string
  readonly seq?: number
  readonly data?: {
    /** A role-carrying message (`user` | `assistant` | `tool` | …). */
    readonly message?: {
      readonly role?: string
      readonly content?: ReadonlyArray<SessionContentBlockLike>
    }
    readonly content?: ReadonlyArray<SessionContentBlockLike>
  }
}

/** `ctx.sessionQuery.readSession` result (structural view). */
export interface SessionLogSnapshotLike {
  /** The real readSession returns the header under `session` (session-query src/index.ts). */
  readonly session: { readonly id: string; readonly cwd?: string }
  readonly events: readonly SessionEventLike[]
}

/**
 * One model-visible conversation message, the shape `Session.deriveMessages()`
 * returns (packages/llm/llm/src/message.ts:196 — every role extends a base
 * carrying `content: readonly ContentBlock[]`). Used by the session-end
 * proposal instead of the removed raw `session.events` (issue #39).
 */
export interface MessageLike {
  /** `system` | `developer` | `user` | `assistant` | `tool`. */
  readonly role?: string
  readonly content?: ReadonlyArray<SessionContentBlockLike>
}

/**
 * `ctx.systemPrompt.section` — packages/core/system-prompt/src/index.ts.
 * The text provider receives the assembly context, which the agent loop
 * augments with the caller agent (`assembleContextFor`, dsh-agent).
 */
export interface SystemPromptLike {
  section(section: {
    readonly name: string
    readonly order: number
    readonly text: string | ((context: PromptAssemblyContext) => string)
  }): () => void
}

/** Per-assembly context view; `agent` is absent on bare/diagnostic assemblies. */
export interface PromptAssemblyContext {
  readonly agent?: CallerAgent
}

/** One registered tool definition (structural view of dsh-tools ToolDefinition). */
export interface ToolDefinitionLike {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly output: {
    readonly schema: Record<string, unknown>
    render(args: unknown, value: unknown): ReadonlyArray<{ readonly type: string; readonly text: string }>
  }
  execute(args: unknown, exec: ToolExec): Promise<unknown>
  readonly timeoutMs?: number
}

/** `ctx.tools.register` — returns the exact disposer that unregisters the tool. */
export interface ToolsRegistryLike {
  register(definition: ToolDefinitionLike): () => void
}

// The plugin row declares `inject: ['tools']`, so `ctx.tools` is guaranteed by
// the harness at runtime; this augmentation mirrors how dsh packages type
// their registries on the shared Context.
declare module '@deepseek-ai/cordis' {
  interface Context {
    tools: ToolsRegistryLike
  }
}
