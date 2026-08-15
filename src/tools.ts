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
// Tool set (5 tools):
//
//   memory_remember  (write, approval-gated) — add or update one fact in the
//                    caller's workspace memory domain.
//   memory_forget    (write, approval-gated) — archive one fact (soft delete).
//   memory_edit      (write, approval-gated) — replace one fact's text/tags.
//   memory_recall    (read, never gated)     — bounded deterministic scan over
//                    active facts of the caller's workspace (text + tags).
//   memory_profile   (read, never gated)     — show the caller's workspace
//                    profile and let the model propose changes (writes go
//                    through memory_remember).
//
// Cross-session recall of PAST SESSIONS rides ctx.sessionQuery.searchEvents
// (FTS; enabled by our bundle patch) under the exact-cwd authorization rule,
// exposed as `memory_search` — TODO: decide whether to fold it into
// memory_recall or keep it a sixth tool; keep tool count low for prompt cost.

import type { Context } from '@deepseek-ai/cordis'

export interface MemoryService {
  // TODO(implement): the handle assembled in src/index.ts.
}

// TODO(implement): registerMemoryTools(ctx, service) — each registration
// wrapped in ctx.effect() so stop/update/undefine unwinds it.

export function registerMemoryTools(ctx: Context, service: MemoryService): void {
  // TODO(implement): the five tools above.
  void service
}
