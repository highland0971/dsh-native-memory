// dsh-native-memory — plugin entry (Host half).
//
// Planes: this row is inserted into the HOST composition by the bundle patch
// (cordis.patch.yml). Memory crosses sessions, so it lives host-side; it
// publishes NO service and consumes the host's registries, so no isolate
// realm is involved. The optional per-workspace prompt profile is a
// systemPrompt section (host-plane, layered per scope like all prompt input).
//
// Degradation (design §7): `storageDomain` absent (headless profile) → the
// plugin stays mounted, memory tools answer MEMORY_DISABLED, the prompt
// section is omitted. `sessionQuery` absent → memory_search answers
// MEMORY_DISABLED. `approval` absent → writes fail closed. Domain
// version-mismatch → loud MEMORY_UNAVAILABLE at first open; memory offline
// until migrated. No hang, no crash.

import type { Context } from '@deepseek-ai/cordis'

import { buildApprovalGate } from './approval.ts'
import { Config } from './config.ts'
import { openMemoryDomain } from './domain.ts'
import type { MemoryDomain, StorageDomainFacility } from './domain.ts'
import { MemoryError } from './errors.ts'
import { registerCompactionGuard } from './guard.ts'
import { registerProfileSection } from './prompt.ts'
import { registerSessionEndProposal } from './propose.ts'
import { registerMemoryTools } from './tools.ts'
import type { MemoryService } from './tools.ts'
import type { SessionQueryServiceLike } from './types.ts'
import { registerFactsRoute } from './web.ts'

export const name = 'dsh-native-memory'

// `tools` is the one registry every profile provides (host-plane; the cordis
// preset's own comments call it that). Everything else is optional-capability
// and resolved with ctx.get so a headless or minimal profile degrades loudly
// instead of hanging the row in `waiting`.
export const inject = ['tools']

export function apply(ctx: Context, config: unknown) {
  const resolved = Config.parse(config ?? {})

  const storageDomain = ctx.get('storageDomain') as StorageDomainFacility | undefined
  const sessionQuery = ctx.get('sessionQuery') as SessionQueryServiceLike | undefined
  const approvalGate = buildApprovalGate(ctx, resolved.approvalWrites)

  // Lazy open, memoized per plugin run: no storage unit is touched until the
  // first memory operation (or the first prompt assembly, which only kicks
  // the open without awaiting it). Failures are memoized too — tools answer
  // the same loud error until the deployment fixes the domain.
  let domainPromise: Promise<MemoryDomain> | undefined
  let opened: MemoryDomain | undefined
  const getDomain = (): Promise<MemoryDomain> => {
    if (storageDomain === undefined) {
      return Promise.reject(new MemoryError(
        'MEMORY_DISABLED',
        'the storage-domain facility is not available in this profile — memory is disabled here',
      ))
    }
    domainPromise ??= openMemoryDomain(storageDomain, resolved).then(domain => {
      opened = domain
      return domain
    })
    return domainPromise
  }

  const service: MemoryService = {
    config: resolved,
    storageDomainAvailable: storageDomain !== undefined,
    getDomain,
    openedDomain: () => opened,
    ensureDomain: () => {
      if (storageDomain !== undefined) void getDomain().catch(() => {})
    },
    approvalGate,
    sessionQuery,
  }

  ctx.effect(() => {
    const disposeTools = registerMemoryTools(ctx, service)
    const disposeProfile = resolved.injectProfile ? registerProfileSection(ctx, service) : undefined
    const disposeWeb = registerFactsRoute(ctx, service)
    const disposeProposal = registerSessionEndProposal(ctx, service)
    const disposeGuard = registerCompactionGuard(ctx, service)
    return async () => {
      disposeTools()
      disposeProfile?.()
      disposeWeb?.()
      disposeProposal?.()
      disposeGuard?.()
      // Close the domain if it ever opened: writes drain, the unit releases,
      // and the domain name frees up for a later open.
      if (domainPromise !== undefined) {
        try {
          const domain = await domainPromise
          await domain.close()
        } catch {
          // A never-opened or failed-open domain has nothing to close.
        }
      }
    }
  })
}
