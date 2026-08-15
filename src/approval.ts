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
// Outcomes: approve / reject / cancelled — grants apply only to the requested
// action; every ask/outcome pair is logged to the requesting session, which
// is the audit trail. Missing answerers fail closed.
//
// Why gate writes at all: memory is injected back into future sessions'
// prompts. A malicious or confused session must not be able to plant durable
// prompt content silently — the human sees every write before it lands. This
// is the direct answer to the injection weakness found in dsh-hermes-memory.

import type { Context } from '@deepseek-ai/cordis'

// The real approval API takes the harness `Agent` object
// (packages/interaction/user-approval/src/index.ts). Its type lives in
// @deepseek-ai/dsh-agent — not yet published standalone; during
// implementation (docs/handoff.md step 1), either add it as a devDependency
// from the harness repo or keep this structural minimum and cast at the call
// site. The scaffold keeps the module typechecking without that dependency.
export interface AgentRef {
  /** Session-scoped identity the approval service routes by. */
  readonly id: string
}

export interface ApprovalGate {
  request: (req: {
    agent: AgentRef
    toolName: string
    reason: string
  }) => Promise<boolean> // true = approved and applied
}

// TODO(implement): buildApprovalGate(ctx, config) — when config.approvalWrites
// is false or ctx.get('approval') is undefined, return a pass-through gate
// (writes then require no human confirmation; still logged by the tool result).
export function buildApprovalGate(ctx: Context, approvalWrites: boolean): ApprovalGate {
  void ctx
  void approvalWrites
  // TODO(implement)
  throw new Error('not implemented')
}
