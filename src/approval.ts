// Approval-gated write path.
//
// Verified contract (packages/interaction/user-approval/src/index.ts):
//
//   ctx.approval.request(req: ApprovalRequest): Promise<ApprovalOutcome>
//   ApprovalRequest: {
//     agent: Agent            // routes the question to this session's UI answerer
//     toolName: string        // presentation + audit
//     callId?: CallId         // attach the question to the already-streamed call
//     reason?: string         // the asker's human-readable WHY (model-written)
//   }
//
// Outcomes: 'allowed-once' (the only grant) / 'rejected' / 'cancelled' /
// 'unavailable' — every ask/outcome pair is logged to the requesting session,
// which is the audit trail. Missing answerers fail closed; a throwing ask is
// contained here and fails closed too, because an unanswered write must never
// land.
//
// Why gate writes at all: memory is injected back into future sessions'
// prompts. A malicious or confused session must not be able to plant durable
// prompt content silently — the human sees every write before it lands. This
// is the direct answer to the injection weakness found in dsh-hermes-memory.

import type { Context } from '@deepseek-ai/cordis'

import type { ApprovalServiceLike } from './types.ts'

export interface ApprovalGate {
  /** Ask the host approval stack; true only for 'allowed-once'. Never throws. */
  request: (req: {
    agent: unknown
    toolName: string
    callId?: unknown
    reason: string
    signal?: AbortSignal
  }) => Promise<boolean>
}

/**
 * Build the write gate for one plugin run.
 *
 * - `approvalWrites: false` → pass-through gate (writes land unasked; the
 *   tool result still records what was stored).
 * - approval service absent (headless profile) → always-deny gate: writes
 *   fail closed, as the design requires.
 * - approval service present → outcomes map to a boolean; a rejected,
 *   cancelled, unavailable, or throwing ask all resolve to `false`.
 */
export function buildApprovalGate(ctx: Context, approvalWrites: boolean): ApprovalGate {
  if (!approvalWrites) {
    return {
      request: async () => true,
    }
  }
  const approval = ctx.get('approval') as ApprovalServiceLike | undefined
  if (approval === undefined) {
    ctx.logger('memory').warn('approval service unavailable in this profile — memory writes fail closed')
    return {
      request: async () => false,
    }
  }
  return {
    request: async (req) => {
      try {
        const outcome = await approval.request({
          agent: req.agent,
          toolName: req.toolName,
          ...(req.callId !== undefined ? { callId: req.callId } : {}),
          reason: req.reason,
          ...(req.signal !== undefined ? { signal: req.signal } : {}),
        })
        if (outcome !== 'allowed-once') {
          ctx.logger('memory').warn(`${req.toolName}: approval outcome '${outcome}' — write failed closed`)
        }
        return outcome === 'allowed-once'
      } catch (error) {
        ctx.logger('memory').warn(`${req.toolName}: approval ask threw: ${String(error)} — write failed closed`)
        return false
      }
    },
  }
}
