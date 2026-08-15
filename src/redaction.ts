// Secret redaction (v0.3.0): deterministic detection of secret-shaped text
// before memory writes and before prompt injection. Mirrors the ecosystem's
// guard rails — dsh-memory-gate (write-time secret rejection), dsh-handoff
// and unified-agent-memory (credential redaction) — with zero dependencies.
//
// Policy (config.secretPolicy):
//   'reject' (default) — fail the write with MEMORY_SECRET_REJECTED;
//   'mask'            — store the text with every secret span replaced by
//                       the fixed marker below;
//   'off'             — store as-is (the user's explicit choice).
// Injection-side masking is ALWAYS on: a secret that somehow reached storage
// (policy off, or a row written by an older version) never re-enters the
// model context verbatim.
//
// Detectors report STABLE KIND LABELS only — error messages and audit lines
// never echo the secret itself.

/** One secret detector: a stable kind label plus a global regular expression. */
export interface SecretPattern {
  readonly kind: string
  readonly pattern: RegExp
}

export const SECRET_PATTERNS: readonly SecretPattern[] = [
  { kind: 'github-pat', pattern: /\bghp_[A-Za-z0-9]{36}\b/g },
  { kind: 'github-fine-grained', pattern: /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g },
  { kind: 'npm-token', pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { kind: 'openai-key', pattern: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'aws-access-key', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'bearer-token', pattern: /\bBearer [A-Za-z0-9._-]{16,}\b/g },
  // The FULL PEM block (header + base64 body + footer): masking the header
  // alone would leave the key material itself verbatim.
  {
    kind: 'private-key',
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g,
  },
  {
    kind: 'credential-assignment',
    pattern: /\b(?:api[_-]?key|token|secret|password|passwd|access[_-]?key)\s*[:=]\s*["']?[A-Za-z0-9_\-./+]{16,}["']?/g,
  },
]

/** The fixed replacement for any secret span. */
export const REDACTED = '[REDACTED]'

/** Which secret kinds appear in the text (stable labels, deduped, sorted). */
export function detectSecrets(text: string): string[] {
  const kinds = new Set<string>()
  for (const { kind, pattern } of SECRET_PATTERNS) {
    pattern.lastIndex = 0
    if (pattern.test(text)) kinds.add(kind)
  }
  return [...kinds].sort()
}

/** Replace every detected secret span with the fixed marker. */
export function maskSecrets(text: string): string {
  let masked = text
  for (const { pattern } of SECRET_PATTERNS) {
    pattern.lastIndex = 0
    masked = masked.replace(pattern, REDACTED)
  }
  return masked
}
