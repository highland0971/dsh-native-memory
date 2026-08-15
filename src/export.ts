// Markdown export mirror (v0.3.0): memory_export projects the workspace's
// facts and profile into a git-friendly Markdown file at
// <cwd>/.dsh-memory/memory.md.
//
// Read-only semantics: the storage domain stays the single source of truth;
// the file is a derived, secret-masked, human-readable projection and is
// NEVER synced back. The write is deterministic and idempotent
// (content-addressed — an unchanged export is not rewritten) and atomic
// (temp file + rename), and it never touches memory state — so no approval
// is involved: the same data is already readable via memory_recall /
// memory_search, and the export adds nothing the model could not already
// see or the user could not already read.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import type { Fact, Profile } from './domain.ts'
import { maskSecrets } from './redaction.ts'

/** Directory (relative to the workspace cwd) holding the export mirror. */
export const EXPORT_DIR = '.dsh-memory'
/** Export file name inside {@link EXPORT_DIR}. */
export const EXPORT_FILE = 'memory.md'

/**
 * Pure: render the masked Markdown mirror. Deterministic — the output is a
 * function of facts + profile ONLY (no wall-clock line), so the
 * content-addressed idempotency in {@link writeExport} is real: an unchanged
 * export is never rewritten.
 */
export function renderExport(facts: readonly Fact[], profile: Profile): string {
  const lines = [
    '# Workspace memory — dsh-native-memory export',
    '',
    '> Read-only mirror of the storage-domain truth — edits here are NOT synced back. '
    + 'Regenerate with memory_export.',
    '',
    '## Profile',
  ]
  if (profile.entries.length === 0) {
    lines.push('(empty)')
  } else {
    for (const entry of profile.entries) lines.push(`- ${maskSecrets(entry)}`)
  }
  lines.push('', `## Facts (${facts.length})`)
  if (facts.length === 0) {
    lines.push('(none)')
  } else {
    for (const fact of facts) {
      const tags = fact.tags.length > 0 ? ` (tags: ${fact.tags.join(', ')})` : ''
      lines.push(
        `- [${fact.kind}] ${maskSecrets(fact.text)}${tags} — session ${fact.sessionId}#${fact.seq} `
        + `— updated ${new Date(fact.updatedAt).toISOString()}`,
      )
    }
  }
  lines.push('')
  return lines.join('\n')
}

/** Write the mirror idempotently and atomically. */
export async function writeExport(
  cwd: string,
  content: string,
): Promise<{ readonly path: string; readonly bytes: number; readonly rewrote: boolean }> {
  const dir = join(cwd, EXPORT_DIR)
  const path = join(dir, EXPORT_FILE)
  await mkdir(dir, { recursive: true })
  let existing = ''
  try {
    existing = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const bytes = Buffer.byteLength(content)
  if (existing === content) return { path, bytes, rewrote: false }
  const temp = `${path}.tmp-${process.pid}-${randomUUID()}`
  await writeFile(temp, content, 'utf8')
  await rename(temp, path)
  return { path, bytes, rewrote: true }
}
