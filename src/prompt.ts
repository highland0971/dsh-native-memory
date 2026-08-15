// Bounded per-workspace profile prompt section.
//
// Verified contract (packages/core/system-prompt/src/index.ts):
//
//   ctx.systemPrompt.section(section: PromptSection): () => void
//   PromptSection: {
//     name: string       // duplicate name throws
//     order: number      // ascending; -100 harness identity, 0 persona,
//                        // tool guidance 100–199
//     text: string | (ctx: AssembleContext) => string   // provider form OK
//   }
//
// We use order 88: after the persona, before tool guidance, and just before
// dsh-hermes-memory's order 90 when both are installed.
//
// Injection hygiene (learned from the hermes review): the section renders
// ONLY the caller session's workspace profile (exact-cwd rule), it is bounded
// by config caps (few entries × short chars), and it frames the entries as
// untrusted persisted notes — the model must treat them as data, not
// instructions, unless the current user repeats them. Future work: wrap in a
// delimiter tag pair and JSON-escape '<' to match the session-reference
// subsystem's hardening.

import type { Context } from '@deepseek-ai/cordis'

export function registerProfileSection(ctx: Context, _service: unknown): void {
  // TODO(implement): ctx.effect(() => ctx.systemPrompt.section({...}))
  // The text provider reads the CURRENT step's session workspace — resolve
  // through the caller identity available to the plugin (see
  // dsh-tool-session-query's caller pattern: ToolExecution.exec.agent), not a
  // captured stale value.
}
