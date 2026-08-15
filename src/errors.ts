// Typed failure vocabulary for the memory plugin.
//
// The plugin cannot import harness packages at runtime (module resolution
// risk across profiles — the hermes precedent), so errors are a small local
// class carrying a stable machine-routable `code`. Tool failures render as
// ordinary error text in the model-facing result.

export type MemoryErrorCode =
  | 'MEMORY_DISABLED'
  | 'MEMORY_MISSING_AGENT'
  | 'MEMORY_UNAUTHORIZED'
  | 'MEMORY_APPROVAL_DENIED'
  | 'MEMORY_INVALID_ARGS'
  | 'MEMORY_NOT_FOUND'
  | 'MEMORY_CAP_EXCEEDED'
  | 'MEMORY_UNAVAILABLE'
  /** Mirrored from the session-query taxonomy when FTS is disabled. */
  | 'SESSION_QUERY_SEARCH_DISABLED'

export class MemoryError extends Error {
  declare readonly name: 'MemoryError'

  constructor(
    readonly code: MemoryErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'MemoryError'
  }
}

/** True when `error` carries a harness-style machine code equal to `code`. */
export function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}
