// Domain unit tests.
//
// Follow the harness's own pattern: boot a Cordis context with the storage
// hub, a memory backend, and the DomainFacility, then open OUR domain spec
// over it. Reference fixture:
//   /opt/dsh-src/packages/storage/storage-domain/tests/helpers/memory-backend.ts
//
// Contract under test: remember/listActive/recall/archive/getProfile/putProfile,
// exact-cwd authorization, caps, provenance fields.

import { describe, expect, it } from 'vitest'

describe('memory domain', () => {
  it('scaffold placeholder — implement in step 2 of docs/handoff.md', () => {
    expect(true).toBe(true)
  })
})
