// dsh-native-memory — plugin entry (Host half).
//
// This skeleton documents the design contract. Every API referenced below was
// verified against deepseek-harness 0.1.0-rc.5 (commit 47f9438) at the cited
// file:line. Fill in the TODO bodies; do not change the architecture without
// updating docs/design.md.
//
// Planes: this row is inserted into the HOST composition by the bundle patch
// (cordis.patch.yml). Memory crosses sessions, so it lives host-side; it
// publishes NO service and consumes the host's registries, so no isolate
// realm is involved. The optional per-workspace prompt profile is a
// systemPrompt section (host-plane, layered per scope like all prompt input).

import type { Context } from '@deepseek-ai/cordis'

import { Config, type ConfigType } from './config.ts'
import type { MemoryDomain } from './domain.ts'
import { registerMemoryTools } from './tools.ts'
import { registerProfileSection } from './prompt.ts'

export const name = 'dsh-native-memory'

// `tools` is the one registry every profile provides (host-plane; the cordis
// preset's own comments call it that). Everything else is optional-capability
// and resolved with ctx.get so a headless or minimal profile degrades loudly
// instead of hanging the row in `waiting`.
export const inject = ['tools']

export function apply(ctx: Context, config: unknown) {
  const resolved = Config.parse(config ?? {})

  // The memory domain rides the host's storage-domain facility (web profile:
  // JSON backend, root ~/.dsh/storages). Absent facility (headless) → the
  // plugin stays mounted but memory tools answer a disabled error.
  const storageDomain = ctx.get('storageDomain')
  let domain: MemoryDomain | undefined
  if (storageDomain !== undefined) {
    // open() is lazy here on purpose: no file is touched until the first
    // memory operation. storage-domain: packages/storage/storage-domain
    //   open(spec): Promise<Domain>   — see src/index.ts of that package.
    // TODO: open the domain asynchronously and hold it for the tool layer;
    // handle DomainError('backend-not-found') and version mismatch loudly.
  }

  // Cross-session recall: session-query is provided by dsh-base in every
  // profile (session-query-sqlite). Search requires FTS — enabled by our
  // bundle patch (openAt: first-search). Exact reads/titles/lineage work
  // even where search stays disabled.
  const sessionQuery = ctx.get('sessionQuery')

  // Approval-gated writes. The approval stack is host-plane; missing it
  // (should not happen in a real profile) fails writes closed.
  const approval = ctx.get('approval')

  // TODO(implement): build the service handle { domain, sessionQuery, approval, config }
  // and pass it to the two registration layers below.

  registerMemoryTools(ctx, { /* TODO: handle */ })
  if (resolved.injectProfile) registerProfileSection(ctx, { /* TODO: handle */ })
}
