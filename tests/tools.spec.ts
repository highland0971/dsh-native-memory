// Tool surface tests.
//
// Contract under test: five tools register into ctx.tools; write tools route
// through the approval gate (mocked) and fail closed; read tools never ask;
// caller workspace authorization enforced via ToolRunContext.exec.agent.

import { describe, expect, it } from 'vitest'

describe('memory tools', () => {
  it('scaffold placeholder — implement in step 3 of docs/handoff.md', () => {
    expect(true).toBe(true)
  })
})
